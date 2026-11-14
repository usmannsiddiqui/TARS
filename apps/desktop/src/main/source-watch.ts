// Local file sources (Obsidian notes; AI transcripts via ai-context.ts). Main process only.
// Canonical realpath allowlist, bounded initial scan, then native change events (fs.watch = FSEvents on macOS).
// No polling: nothing here runs on a timer. Bursts are coalesced by content hash.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  EvidenceIdSchema,
  SourceIdSchema,
  type Evidence,
  type OwnerId,
  type ProjectId,
  type SourceGrant,
  type SourceId,
  type SourceKind,
} from "@companion/domain";
import type { CloudSync } from "./cloud-handoff";
import type { LocalGrantRecord } from "./local-store";
import { logTargetId } from "./outcome-log";

export type Extracted = { text: string; truncated: boolean } | { unsupported: string };

/** How one kind of local source turns a file into evidence text. */
export type FileReader = {
  /** Called with the externalId ("/"-separated, relative to the selected root). */
  accepts(externalId: string): boolean;
  maxBytes: number;
  /** Initial-scan cap; the most recently modified files win. */
  maxFiles: number;
  extract(content: string): Extracted;
};

// A working note above 1 MB is almost always an export or pasted attachment, not something to reason over.
export const MARKDOWN_MAX_BYTES = 1_000_000;
const MARKDOWN_MAX_FILES = 2_000;

export const markdownReader: FileReader = {
  accepts: (id) => id.toLowerCase().endsWith(".md"),
  maxBytes: MARKDOWN_MAX_BYTES,
  maxFiles: MARKDOWN_MAX_FILES,
  extract: (text) => ({ text, truncated: false }),
};

export type SourceIssue = {
  externalId: string;
  issue: "too-large" | "outside-grant" | "over-file-cap" | "unsupported" | "truncated" | "unreadable";
  detail?: string;
};
export type SourceStatus = { freshness: "current" | "stale"; reason?: string; files: number; issues: SourceIssue[] };
export type WatchOptions = { reader?: FileReader; onStatus?: (status: SourceStatus) => void };
export type WatchHandle = (() => void) & {
  status(): SourceStatus;
  /** Settles when the current scan finishes (also after disposal). */
  ready: Promise<void>;
  /** Restart native watchers and rescan once, e.g. after the Mac wakes or a root reappears. */
  reconcile(): Promise<void>;
};

type Root = { real: string; isFile: boolean; missing?: string; watcher?: FSWatcher };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const isHidden = (externalId: string) => externalId.split("/").some((part) => part.startsWith("."));

async function resolveRoots(selectors: string[]): Promise<Root[]> {
  return Promise.all(
    selectors.map(async (selector): Promise<Root> => {
      try {
        const real = await realpath(selector);
        return { real, isFile: (await stat(real)).isFile() };
      } catch {
        return { real: selector, isFile: false, missing: "selected path is missing" };
      }
    }),
  );
}

export function watchSelected(grant: SourceGrant, emit: (evidence: Evidence) => void, options: WatchOptions = {}): WatchHandle {
  return track(grant, emit, options, true);
}

/** One bounded read of the selection with no watcher (used by readAiContext). */
export async function scanSelected(grant: SourceGrant, reader: FileReader): Promise<{ records: Evidence[]; status: SourceStatus }> {
  const records: Evidence[] = [];
  const handle = track(grant, (e) => records.push(e), { reader }, false);
  await handle.ready;
  const status = handle.status();
  handle();
  return { records, status };
}

function track(grant: SourceGrant, emit: (evidence: Evidence) => void, options: WatchOptions, live: boolean): WatchHandle {
  if (grant.state !== "active" || !grant.read) throw new Error("Source grant is not active");
  const reader = options.reader ?? markdownReader;
  let disposed = false;
  let scanning = true;
  let roots: Root[] = [];
  let writeTargets = new Set<string>();
  const known = new Map<string, string>(); // externalId -> version (content hash)
  const issues = new Map<string, SourceIssue>();
  const latest = new Map<string, number>(); // path -> newest read, so an older read never wins
  let reads = 0;

  const status = (): SourceStatus => {
    const reason = disposed ? "stopped" : scanning ? "scanning" : roots.find((r) => r.missing)?.missing;
    return { freshness: reason ? "stale" : "current", ...(reason ? { reason } : {}), files: known.size, issues: [...issues.values()] };
  };
  const report = () => {
    if (!disposed) options.onStatus?.(status());
  };
  const setIssue = (externalId: string, issue: SourceIssue["issue"], detail?: string) => {
    issues.set(externalId, { externalId, issue, ...(detail ? { detail } : {}) });
    report();
  };

  const idFor = (root: Root, path: string) => {
    const id = root.isFile ? basename(path) : relative(root.real, path).split(sep).join("/");
    return roots.length > 1 ? `${basename(root.real)}/${id}` : id;
  };
  const containing = (real: string) =>
    roots.find((r) => !r.missing && (r.isFile ? real === r.real : real.startsWith(r.real + sep)));

  async function processFile(candidate: string, root: Root): Promise<void> {
    const mine = ++reads;
    latest.set(candidate, mine);
    const superseded = () => disposed || latest.get(candidate) !== mine;
    const candidateId = idFor(root, candidate);
    try {
      // Resolve before the allowlist check: a symlink's own path says nothing about where it points.
      const real = await realpath(candidate);
      if (superseded()) return;
      const owner = containing(real);
      if (!owner) return setIssue(candidateId, "outside-grant");
      // Our own outcome log is a write target, never evidence: its edits must not create obligations.
      if (writeTargets.has(real)) return;
      const externalId = idFor(owner, real);
      if (!reader.accepts(externalId)) return;
      const info = await stat(real);
      if (superseded() || !info.isFile()) return;
      if (info.size > reader.maxBytes) return setIssue(externalId, "too-large", `${info.size} bytes > ${reader.maxBytes}`);
      const content = await readFile(real, "utf8");
      if (superseded()) return;
      const extracted = reader.extract(content);
      if ("unsupported" in extracted) return setIssue(externalId, "unsupported", extracted.unsupported);
      if (extracted.truncated) setIssue(externalId, "truncated");
      else issues.delete(externalId);
      const version = sha256(extracted.text);
      if (known.get(externalId) === version) return; // duplicate event or unchanged content
      known.set(externalId, version);
      const receivedAt = new Date().toISOString();
      emit({
        id: EvidenceIdSchema.parse(sha256(`${grant.id}\0${externalId}\0${version}`).slice(0, 32)),
        ownerId: grant.ownerId,
        sourceId: grant.id,
        externalId,
        version,
        text: extracted.text,
        occurredAt: info.mtime.toISOString(),
        receivedAt,
        projectIds: [...grant.projectIds],
        grantVersion: grant.version,
        freshness: "current",
        origin: "live",
      });
      report();
    } catch (err) {
      if (superseded()) return;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Deleted or renamed away: forget it so a re-creation emits again.
        known.delete(candidateId);
        issues.delete(candidateId);
        return report();
      }
      setIssue(candidateId, "unreadable", (err as NodeJS.ErrnoException).code ?? "read failed");
    }
  }

  async function scan(): Promise<void> {
    const candidates: { path: string; root: Root; mtimeMs: number }[] = [];
    for (const root of roots) {
      if (root.missing) continue;
      try {
        const paths = root.isFile
          ? [root.real]
          : (await readdir(root.real, { recursive: true, withFileTypes: true }))
              .filter((e) => e.isFile() || e.isSymbolicLink()) // symlinked dirs are listed, never descended
              .map((e) => join(e.parentPath, e.name));
        for (const path of paths) {
          const id = idFor(root, path);
          if (isHidden(id) || !reader.accepts(id)) continue;
          const mtimeMs = await stat(path).then((s) => s.mtimeMs, () => 0);
          candidates.push({ path, root, mtimeMs });
        }
      } catch {
        root.missing = "selected path is missing";
      }
      if (disposed) return;
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const skipped = candidates.length - reader.maxFiles;
    if (skipped > 0) setIssue("*", "over-file-cap", `${skipped} not read (over the ${reader.maxFiles}-file cap)`);
    else issues.delete("*");
    for (const c of candidates.slice(0, reader.maxFiles)) {
      if (disposed) return;
      await processFile(c.path, c.root);
    }
  }

  function markMissing(root: Root, reason: string) {
    root.missing = reason;
    root.watcher?.close();
    report();
  }

  function startWatchers() {
    for (const root of roots) {
      if (root.missing) continue;
      // A selected file is watched through its folder: an atomic save replaces the file's inode.
      const dir = root.isFile ? dirname(root.real) : root.real;
      try {
        root.watcher = watch(dir, { recursive: !root.isFile }, (_event, filename) => {
          if (disposed || root.missing) return;
          // FSEvents reports a removed watched folder as an event, not an error.
          if (!existsSync(dir)) return markMissing(root, "selected path is missing");
          if (filename === null) return void scan();
          const path = join(dir, filename);
          if (root.isFile && path !== root.real) return;
          const id = idFor(root, path);
          if (!isHidden(id) && reader.accepts(id)) void processFile(path, root);
        });
        root.watcher.on("error", () => markMissing(root, "file watcher stopped"));
      } catch {
        markMissing(root, "selected path is missing");
      }
    }
  }

  async function reconcile(): Promise<void> {
    if (disposed) return;
    for (const root of roots) root.watcher?.close();
    scanning = true;
    report();
    roots = await resolveRoots(grant.selectors);
    writeTargets = new Set((await resolveRoots(grant.writeTargets)).map((r) => r.real));
    if (disposed) return;
    if (live) startWatchers(); // before the scan, so changes during the scan are not missed
    await scan();
    if (disposed) return;
    scanning = false;
    report();
  }

  const dispose = () => {
    disposed = true; // every read checks this after each await, so nothing in flight can emit
    for (const root of roots) root.watcher?.close();
  };
  let ready = reconcile();
  const handle = Object.assign(dispose, { status, reconcile: () => (ready = reconcile()) });
  // A live getter: Object.assign would copy a getter's value once.
  return Object.defineProperty(handle, "ready", { get: () => ready }) as WatchHandle;
}

/** Honest, human-readable coverage for a source's current status. */
export function coverageLabel(kind: SourceKind, status: SourceStatus): string {
  const surface = SURFACES[kind] ?? kind;
  const noun = kind === "obsidian" ? "note" : kind === "observation" ? "excerpt" : "session";
  const count = (issue: SourceIssue["issue"]) => status.issues.filter((i) => i.issue === issue).length;
  const parts = [`${status.files} ${noun}${status.files === 1 ? "" : "s"} read`];
  const labels: [SourceIssue["issue"], string][] = [
    ["truncated", "truncated to recent turns"],
    ["too-large", "too large, skipped"],
    ["outside-grant", "outside the grant, denied"],
    ["unsupported", "unrecognized format"],
    ["unreadable", "unreadable"],
  ];
  for (const [issue, label] of labels) if (count(issue)) parts.push(`${count(issue)} ${label}`);
  const capped = status.issues.find((i) => i.issue === "over-file-cap");
  if (capped?.detail) parts.push(capped.detail);
  return `${surface}: ${parts.join("; ")}${status.freshness === "stale" ? ` (stale: ${status.reason})` : ""}`;
}

const SURFACES: Partial<Record<SourceKind, string>> = {
  obsidian: "Obsidian notes (Markdown)",
  "claude-code": "Claude Code CLI sessions (selected project folder, top-level sessions only)",
  codex: "Codex CLI sessions (selected folder)",
  observation: "Text of the selected apps and sites",
};

// ---- Selected-source registry: what the IPC layer drives. Grants persist (encrypted) in the local store.

export type LocalSourceKind = "obsidian" | "claude-code" | "codex";
export type LocalSourceView = {
  id: SourceId;
  kind: SourceKind;
  name: string;
  projectIds: ProjectId[];
  state: SourceGrant["state"];
  version: number;
  freshness: "current" | "stale";
  reason?: string;
  coverage: string;
  /** Off until the user consents for this source; while off nothing from it leaves the Mac. */
  cloudProcessing: boolean;
  cloudSync?: CloudSync;
};
export type LocalSourcesDeps = {
  /** OS dialog in the main process; the renderer never supplies a path. "note": one existing Markdown file. */
  pickPath(purpose?: "note"): Promise<string | null>;
  start(grant: SourceGrant, emit: (evidence: Evidence) => void, options: WatchOptions): Promise<WatchHandle>;
  store: {
    enqueueEvidence(evidence: Evidence, ownerId: OwnerId): Promise<boolean>;
    discardSource(ownerId: OwnerId, sourceId: SourceId): Promise<number>;
    saveGrant(record: LocalGrantRecord): Promise<void>;
    loadGrants(ownerId: OwnerId): Promise<LocalGrantRecord[]>;
  };
  /** Something the cloud hand-off should act on: new evidence, a consent change or a revoke. */
  onChange(ownerId: OwnerId): void;
};

type Entry = LocalGrantRecord & { handle?: WatchHandle; error?: string; cloudSync?: CloudSync };

export function createLocalSources(deps: LocalSourcesDeps) {
  const entries = new Map<SourceId, Entry>();

  // Revoked grants stay in memory (and on disk) only so the cloud can be told; they are not usable.
  const find = (ownerId: OwnerId, sourceId: string): Entry => {
    const entry = entries.get(sourceId as SourceId);
    if (!entry || entry.grant.ownerId !== ownerId || entry.grant.state === "revoked") throw new Error("Unknown source");
    return entry;
  };
  const persist = (entry: Entry) => deps.store.saveGrant({ grant: entry.grant, mirroredVersion: entry.mirroredVersion });
  const stop = (entry: Entry) => {
    entry.handle?.();
    delete entry.handle;
  };

  const view = (entry: Entry): LocalSourceView => {
    const { grant } = entry;
    const status: SourceStatus = entry.handle?.status() ?? { freshness: "stale", reason: "paused", files: 0, issues: [] };
    const reason = entry.error ?? status.reason;
    return {
      id: grant.id,
      kind: grant.kind,
      name: grant.selectors.map((s) => basename(s)).join(", "),
      projectIds: grant.projectIds,
      state: grant.state,
      version: grant.version,
      freshness: entry.error ? "stale" : status.freshness,
      ...(reason ? { reason } : {}),
      coverage: coverageLabel(grant.kind, status),
      cloudProcessing: grant.cloudProcessing,
      ...(entry.cloudSync ? { cloudSync: entry.cloudSync } : {}),
    };
  };

  /** A new active grant; an unsupported or unsaved selection grants nothing. */
  async function add(ownerId: OwnerId, kind: SourceKind, selectors: string[], projectIds: ProjectId[]): Promise<LocalSourceView> {
    const entry: Entry = {
      grant: {
        id: SourceIdSchema.parse(randomUUID()),
        ownerId,
        kind,
        selectors,
        projectIds,
        read: true,
        writeTargets: [],
        cloudProcessing: false,
        version: 1,
        state: "active",
      },
      mirroredVersion: null,
    };
    entries.set(entry.grant.id, entry);
    try {
      await start(entry);
      await persist(entry);
    } catch (err) {
      stop(entry);
      entries.delete(entry.grant.id);
      throw err;
    }
    return view(entry);
  }

  async function start(entry: Entry): Promise<void> {
    const sourceId = entry.grant.id;
    entry.handle = await deps.start(
      entry.grant,
      (evidence) => {
        // Results from an old grant version (revoked/paused in the meantime) are dropped, never buffered.
        const current = entries.get(sourceId)?.grant;
        if (!current || current.state !== "active" || current.version !== evidence.grantVersion) return;
        deps.store.enqueueEvidence(evidence, current.ownerId).then(
          (added) => {
            delete entry.error;
            if (added) deps.onChange(current.ownerId);
          },
          (err: unknown) => {
            entry.error = "could not save evidence locally";
            console.error("evidence outbox write failed", err);
          },
        );
      },
      {},
    );
  }

  return {
    async choose(ownerId: OwnerId, input: { kind: LocalSourceKind; projectIds: ProjectId[] }): Promise<LocalSourceView | null> {
      const path = await deps.pickPath();
      return path ? add(ownerId, input.kind, [path], input.projectIds) : null;
    },
    /** Observation of the apps/sites the user selected; one active observation at a time (one helper). */
    async observe(ownerId: OwnerId, input: { selectors: string[]; projectIds: ProjectId[] }): Promise<LocalSourceView> {
      const active = [...entries.values()].some(
        (e) => e.grant.ownerId === ownerId && e.grant.kind === "observation" && e.grant.state === "active",
      );
      if (active) throw new Error("Only one observation can run at a time: pause or revoke the current one first");
      return add(ownerId, "observation", input.selectors, input.projectIds);
    },
    /** Deletes retained (unsent) observation excerpts. Separate from pause: pausing keeps them. */
    async deleteRetained(ownerId: OwnerId, sourceId: string): Promise<void> {
      const entry = find(ownerId, sourceId);
      if (entry.grant.kind !== "observation") throw new Error("Unknown source");
      await deps.store.discardSource(ownerId, entry.grant.id);
    },
    /**
     * The user picks the outcome-log note in the OS dialog; it becomes this notes grant's write target,
     * so the watcher stops reading it as evidence. Returns the opaque id the cloud names it by.
     */
    async designateLog(ownerId: OwnerId, sourceId: string): Promise<{ sourceId: SourceId; target: string; name: string } | null> {
      const entry = find(ownerId, sourceId);
      if (entry.grant.kind !== "obsidian") throw new Error("Only an Obsidian notes source can hold the outcome log");
      const picked = await deps.pickPath("note");
      if (!picked) return null;
      const note = await realpath(picked);
      if (!note.toLowerCase().endsWith(".md")) throw new Error("Choose a Markdown note (.md) for the outcome log");
      const roots = await resolveRoots(entry.grant.selectors);
      if (!roots.some((r) => !r.missing && !r.isFile && note.startsWith(r.real + sep))) {
        throw new Error("Choose a note inside the selected notes folder");
      }
      // A new version, as with consent: evidence read under the old one must not be sent under the new one.
      stop(entry);
      entry.grant = { ...entry.grant, writeTargets: [note], version: entry.grant.version + 1 };
      delete entry.cloudSync;
      await persist(entry);
      await deps.store.discardSource(ownerId, entry.grant.id);
      if (entry.grant.state === "active") await start(entry);
      deps.onChange(ownerId);
      return { sourceId: entry.grant.id, target: logTargetId(note), name: basename(note) };
    },
    /** Loads the owner's saved grants (app start, sign-in) and restarts watchers of active ones. */
    async restore(ownerId: OwnerId): Promise<void> {
      for (const record of await deps.store.loadGrants(ownerId)) {
        if (entries.has(record.grant.id)) continue;
        const entry: Entry = { ...record };
        entries.set(record.grant.id, entry);
        if (record.grant.state !== "active") continue;
        await start(entry).catch((err: unknown) => {
          entry.error = "could not restart watching";
          console.error("source restore failed", err);
        });
      }
    },
    list(ownerId: OwnerId): LocalSourceView[] {
      return [...entries.values()]
        .filter((e) => e.grant.ownerId === ownerId && e.grant.state !== "revoked")
        .map(view);
    },
    async pause(ownerId: OwnerId, sourceId: string): Promise<LocalSourceView> {
      const entry = find(ownerId, sourceId);
      stop(entry);
      entry.grant = { ...entry.grant, state: "paused" };
      await persist(entry);
      return view(entry);
    },
    async resume(ownerId: OwnerId, sourceId: string): Promise<LocalSourceView> {
      const entry = find(ownerId, sourceId);
      if (entry.grant.state === "paused") {
        entry.grant = { ...entry.grant, state: "active" };
        await persist(entry);
        await start(entry);
      }
      return view(entry);
    },
    /** Stops the watcher, bumps the grant version, discards unsynced evidence of the old version. */
    async revoke(ownerId: OwnerId, sourceId: string): Promise<{ id: SourceId; state: "revoked"; version: number }> {
      const entry = find(ownerId, sourceId);
      stop(entry);
      const version = entry.grant.version + 1;
      entry.grant = { ...entry.grant, state: "revoked", version };
      await persist(entry);
      await deps.store.discardSource(ownerId, entry.grant.id);
      deps.onChange(ownerId);
      return { id: entry.grant.id, state: "revoked", version };
    },
    /**
     * Consent for cloud processing of one source. Each change is a new grant version, so anything
     * queued or in flight under the old consent is denied; active sources rescan under the new one.
     */
    async setCloudProcessing(ownerId: OwnerId, sourceId: string, enabled: boolean): Promise<LocalSourceView> {
      const entry = find(ownerId, sourceId);
      if (entry.grant.cloudProcessing === enabled) return view(entry);
      stop(entry);
      entry.grant = { ...entry.grant, cloudProcessing: enabled, version: entry.grant.version + 1 };
      delete entry.cloudSync;
      await persist(entry);
      await deps.store.discardSource(ownerId, entry.grant.id);
      if (entry.grant.state === "active") await start(entry);
      deps.onChange(ownerId);
      return view(entry);
    },
    /** Every grant of the owner, revoked ones included, for the cloud hand-off. */
    cloudGrants(ownerId: OwnerId): LocalGrantRecord[] {
      return [...entries.values()]
        .filter((e) => e.grant.ownerId === ownerId)
        .map((e) => ({ grant: e.grant, mirroredVersion: e.mirroredVersion }));
    },
    /** The cloud confirmed this grant version. */
    async markMirrored(ownerId: OwnerId, sourceId: SourceId, version: number): Promise<void> {
      const entry = entries.get(sourceId);
      if (!entry || entry.grant.ownerId !== ownerId) return;
      entry.mirroredVersion = Math.max(entry.mirroredVersion ?? 0, version);
      await persist(entry);
    },
    setCloudSync(sourceId: SourceId, status: CloudSync): void {
      const entry = entries.get(sourceId);
      if (entry) entry.cloudSync = status;
    },
    /** After sleep/wake: one reconcile per active source, driven by the OS resume event. */
    reconcileAll(): void {
      for (const entry of entries.values()) void entry.handle?.reconcile();
    },
  };
}
