// Real filesystem + native fs.watch (FSEvents on macOS) in temp folders with synthetic notes only.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectIdSchema, SourceIdSchema, type Evidence, type OwnerId, type SourceGrant, type SourceKind } from "@companion/domain";
import { watchAiContext } from "../../apps/desktop/src/main/ai-context";
import { aesGcmCipher, openLocalStore, type LocalStore } from "../../apps/desktop/src/main/local-store";
import {
  createLocalSources,
  MARKDOWN_MAX_BYTES,
  watchSelected,
  type SourceStatus,
  type WatchHandle,
} from "../../apps/desktop/src/main/source-watch";
import { makeOwners } from "../fixtures";

let dir: string;
const handles: WatchHandle[] = [];
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "companion-sources-")));
});
afterEach(() => {
  for (const h of handles.splice(0)) h();
  rmSync(dir, { recursive: true, force: true });
});

function grantFor(ownerId: OwnerId, selectors: string[], kind: SourceKind = "obsidian"): SourceGrant {
  return {
    id: SourceIdSchema.parse(`source-${randomBytes(4).toString("hex")}`),
    ownerId,
    kind,
    selectors,
    projectIds: [ProjectIdSchema.parse("project-avt")],
    read: true,
    writeTargets: [],
    cloudProcessing: false,
    version: 3,
    state: "active",
  };
}

/** Collects emitted evidence; `next(pred)` resolves on the first (past or future) match. Event-driven, no sleeps. */
function collector() {
  const seen: Evidence[] = [];
  const waiters: { pred: (e: Evidence) => boolean; resolve: (e: Evidence) => void }[] = [];
  return {
    seen,
    emit(e: Evidence) {
      seen.push(e);
      for (const w of waiters.splice(0)) if (w.pred(e)) w.resolve(e); else waiters.push(w);
    },
    next(pred: (e: Evidence) => boolean): Promise<Evidence> {
      const hit = seen.find(pred);
      return hit ? Promise.resolve(hit) : new Promise((resolve) => waiters.push({ pred, resolve }));
    },
  };
}

function statusWatcher() {
  const waiters: { pred: (s: SourceStatus) => boolean; resolve: (s: SourceStatus) => void }[] = [];
  return {
    onStatus(s: SourceStatus) {
      for (const w of waiters.splice(0)) if (w.pred(s)) w.resolve(s); else waiters.push(w);
    },
    next: (pred: (s: SourceStatus) => boolean) => new Promise<SourceStatus>((resolve) => waiters.push({ pred, resolve })),
  };
}

function watch(grant: SourceGrant, c: ReturnType<typeof collector>, onStatus?: (s: SourceStatus) => void) {
  const h = watchSelected(grant, (e) => c.emit(e), onStatus ? { onStatus } : {});
  handles.push(h);
  return h;
}

describe("local sources (Obsidian folders/files)", () => {
  it("emits create, edit and rename with relative id, content-hash version and grant metadata", async () => {
    const { alice } = makeOwners();
    const grant = grantFor(alice.ownerId, [dir]);
    const c = collector();
    const h = watch(grant, c);
    await h.ready;
    expect(h.status().freshness).toBe("current");

    mkdirSync(join(dir, "plans"));
    writeFileSync(join(dir, "plans", "avt.md"), "# AVT\nbuild order v1");
    const created = await c.next((e) => e.externalId === "plans/avt.md");
    expect(created).toMatchObject({
      ownerId: alice.ownerId,
      sourceId: grant.id,
      text: "# AVT\nbuild order v1",
      projectIds: grant.projectIds,
      grantVersion: 3,
      freshness: "current",
      origin: "live",
    });

    writeFileSync(join(dir, "plans", "avt.md"), "# AVT\nbuild order v2");
    const edited = await c.next((e) => e.externalId === "plans/avt.md" && e.text.endsWith("v2"));
    expect(edited.version).not.toBe(created.version);

    renameSync(join(dir, "plans", "avt.md"), join(dir, "plans", "avt-final.md"));
    const renamed = await c.next((e) => e.externalId === "plans/avt-final.md");
    expect(renamed.version).toBe(edited.version);
  });

  it("atomic_replace_still_emits_once", async () => {
    const { alice } = makeOwners();
    writeFileSync(join(dir, "note.md"), "first");
    const c = collector();
    const h = watch(grantFor(alice.ownerId, [dir]), c);
    await c.next((e) => e.externalId === "note.md" && e.text === "first");
    await h.ready;

    // Editor-style save: write a temp file, rename it over the note (two native events for note.md).
    writeFileSync(join(dir, ".note.md.tmp"), "second");
    renameSync(join(dir, ".note.md.tmp"), join(dir, "note.md"));
    await c.next((e) => e.text === "second");
    // Same-content rewrite: an event fires but the hash is unchanged.
    writeFileSync(join(dir, "note.md"), "second");
    // Barrier: native events arrive in order, so once this lands the earlier ones have been handled.
    writeFileSync(join(dir, "barrier.md"), "barrier");
    await c.next((e) => e.externalId === "barrier.md");

    expect(c.seen.filter((e) => e.externalId === "note.md").map((e) => e.text)).toEqual(["first", "second"]);
    expect(c.seen.some((e) => e.externalId.includes(".tmp"))).toBe(false);
  });

  it("symlink_cannot_escape_grant", async () => {
    const { alice } = makeOwners();
    const vault = join(dir, "vault");
    const outside = join(dir, "outside");
    mkdirSync(vault);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.md"), "outside the grant");
    writeFileSync(join(vault, "ok.md"), "inside");
    symlinkSync(join(outside, "secret.md"), join(vault, "link.md"));
    symlinkSync(outside, join(vault, "linked-dir"));

    const c = collector();
    const h = watch(grantFor(alice.ownerId, [vault]), c);
    await h.ready;
    expect(c.seen.map((e) => e.externalId)).toEqual(["ok.md"]);
    expect(h.status().issues).toContainEqual(expect.objectContaining({ externalId: "link.md", issue: "outside-grant" }));

    // A symlink created while watching is denied the same way.
    symlinkSync(join(outside, "secret.md"), join(vault, "late-link.md"));
    writeFileSync(join(vault, "barrier.md"), "barrier");
    await c.next((e) => e.externalId === "barrier.md");
    expect(c.seen.some((e) => e.text === "outside the grant")).toBe(false);
  });

  it("reports an oversize file instead of silently dropping it", async () => {
    const { alice } = makeOwners();
    writeFileSync(join(dir, "huge.md"), "x".repeat(MARKDOWN_MAX_BYTES + 1));
    writeFileSync(join(dir, "small.md"), "fine");
    const c = collector();
    const h = watch(grantFor(alice.ownerId, [dir]), c);
    await h.ready;
    expect(c.seen.map((e) => e.externalId)).toEqual(["small.md"]);
    expect(h.status().issues).toContainEqual(expect.objectContaining({ externalId: "huge.md", issue: "too-large" }));
  });

  it("watches a single selected file across atomic replacement", async () => {
    const { alice } = makeOwners();
    const file = join(dir, "log.md");
    writeFileSync(file, "a");
    writeFileSync(join(dir, "other.md"), "not selected");
    const c = collector();
    const h = watch(grantFor(alice.ownerId, [file]), c);
    await h.ready;
    writeFileSync(join(dir, ".log.tmp"), "b");
    renameSync(join(dir, ".log.tmp"), file);
    await c.next((e) => e.text === "b");
    expect(c.seen.map((e) => [e.externalId, e.text])).toEqual([
      ["log.md", "a"],
      ["log.md", "b"],
    ]);
  });

  it("offline_local_source_is_stale", async () => {
    const { alice } = makeOwners();
    // Root missing at start: never presented as current.
    const missing = watch(grantFor(alice.ownerId, [join(dir, "nope")]), collector());
    await missing.ready;
    expect(missing.status()).toMatchObject({ freshness: "stale" });

    // Root removed while watching: stale, until an explicit reconcile finds it again.
    const vault = join(dir, "vault");
    mkdirSync(vault);
    writeFileSync(join(vault, "a.md"), "a");
    const s = statusWatcher();
    const c = collector();
    const h = watch(grantFor(alice.ownerId, [vault]), c, s.onStatus);
    await h.ready;
    expect(h.status().freshness).toBe("current");
    const goneStatus = s.next((st) => st.freshness === "stale");
    rmSync(vault, { recursive: true });
    expect((await goneStatus).reason).toMatch(/missing/);
    expect(h.status().freshness).toBe("stale");

    mkdirSync(vault);
    writeFileSync(join(vault, "b.md"), "b");
    await h.reconcile();
    expect(h.status().freshness).toBe("current");
    await c.next((e) => e.externalId === "b.md");
  });

  it("disposal invalidates an in-flight read", async () => {
    const { alice } = makeOwners();
    writeFileSync(join(dir, "a.md"), "a");
    const c = collector();
    const h = watchSelected(grantFor(alice.ownerId, [dir]), (e) => c.emit(e));
    h(); // initial scan is in flight
    await h.ready;
    expect(c.seen).toEqual([]);
    expect(h.status().freshness).toBe("stale");
  });

  it("transcript file changes reuse the same native watcher", async () => {
    const { alice } = makeOwners();
    const projects = join(dir, "claude", "projects");
    const project = join(projects, "-tmp-demo");
    mkdirSync(project, { recursive: true });
    const session = join(project, "s1.jsonl");
    const turn = (role: "user" | "assistant", text: string) =>
      JSON.stringify({ type: role, message: { role, content: [{ type: "text", text }] } }) + "\n";
    writeFileSync(session, turn("user", "plan the AVT demo"));
    const c = collector();
    const h = await watchAiContext(grantFor(alice.ownerId, [project], "claude-code"), (e) => c.emit(e), {}, {
      claudeProjects: projects,
      codexSessions: join(dir, "codex"),
    });
    handles.push(h);
    await c.next((e) => e.externalId === "s1.jsonl");
    appendFileSync(session, turn("assistant", "outline drafted"));
    const updated = await c.next((e) => e.text.includes("outline drafted"));
    expect(updated.text).toContain("user: plan the AVT demo");
  });
});

describe("local source manager", () => {
  let store: LocalStore;
  beforeEach(() => {
    store = openLocalStore(join(dir, "local.db"), aesGcmCipher(randomBytes(32)));
  });
  afterEach(() => store.close());

  it("revocation_discards_buffered_file", async () => {
    const { alice } = makeOwners();
    const vault = join(dir, "vault");
    mkdirSync(vault);
    writeFileSync(join(vault, "a.md"), "buffered while cloud unreachable");

    let enqueued!: () => void;
    const firstEnqueue = new Promise<void>((resolve) => (enqueued = resolve));
    const outbox = {
      enqueueEvidence: async (e: Evidence, owner: OwnerId) => {
        const added = await store.enqueueEvidence(e, owner);
        enqueued();
        return added;
      },
      discardSource: store.discardSource,
    };
    const sources = createLocalSources({
      pickPath: async () => vault,
      start: async (grant, emit, options) => watchSelected(grant, emit, options),
      outbox,
    });
    const chosen = await sources.choose(alice.ownerId, { kind: "obsidian", projectIds: [ProjectIdSchema.parse("p1")] });
    if (!chosen) throw new Error("expected a selection");
    await firstEnqueue;
    expect((await store.loadOutbox(alice.ownerId)).map((e) => e.text)).toEqual(["buffered while cloud unreachable"]);

    const revoked = await sources.revoke(alice.ownerId, chosen.id);
    expect(revoked).toEqual({ id: chosen.id, state: "revoked", version: chosen.version + 1 });
    expect(await store.loadOutbox(alice.ownerId)).toEqual([]);
    expect(sources.list(alice.ownerId)).toEqual([]);
  });

  it("is owner-scoped and reports paused sources as stale", async () => {
    const { alice, bob } = makeOwners();
    const sources = createLocalSources({
      pickPath: async () => dir,
      start: async (grant, emit, options) => watchSelected(grant, emit, options),
      outbox: store,
    });
    const chosen = await sources.choose(alice.ownerId, { kind: "obsidian", projectIds: [ProjectIdSchema.parse("p1")] });
    if (!chosen) throw new Error("expected a selection");
    expect(sources.list(bob.ownerId)).toEqual([]);
    await expect(sources.revoke(bob.ownerId, chosen.id)).rejects.toThrow("Unknown source");
    await expect(sources.pause(bob.ownerId, chosen.id)).rejects.toThrow("Unknown source");

    const paused = await sources.pause(alice.ownerId, chosen.id);
    expect(paused).toMatchObject({ state: "paused", freshness: "stale", reason: "paused" });
    const resumed = await sources.resume(alice.ownerId, chosen.id);
    expect(resumed.state).toBe("active");
    await sources.revoke(alice.ownerId, chosen.id);
  });

  it("returns null and grants nothing when the dialog is cancelled", async () => {
    const { alice } = makeOwners();
    const sources = createLocalSources({
      pickPath: async () => null,
      start: async (grant, emit, options) => watchSelected(grant, emit, options),
      outbox: store,
    });
    expect(await sources.choose(alice.ownerId, { kind: "obsidian", projectIds: [ProjectIdSchema.parse("p1")] })).toBeNull();
    expect(sources.list(alice.ownerId)).toEqual([]);
  });
});
