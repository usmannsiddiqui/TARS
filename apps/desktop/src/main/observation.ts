// Main-process side of the native observer helper (native/observer). The helper is not trusted to enforce
// scope alone: every stdout line is schema-validated and re-checked against the current grant before emit.
// No polling and no restart loop: helper exit or permission loss is surfaced as a status, and the user acts.
// Observation never touches focus; this module only emits ObservationEvents for the caller to retain.
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { z } from "zod";
import { EvidenceIdSchema, type Evidence, type ObservationEvent, type SourceGrant, type SourceId } from "@companion/domain";
import type { SourceStatus, WatchHandle } from "./source-watch";

/** The subset of ChildProcessWithoutNullStreams we use, so tests can inject a fake helper. */
export type HelperChild = {
  stdin: { write(chunk: string): unknown; end(): unknown; on(event: "error", listener: (err: Error) => void): unknown };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (err: Error) => void): unknown;
  kill(): unknown;
};

export type ObservationStatus =
  | { state: "ready" | "permission-missing" | "paused" }
  | { state: "unsupported-app"; bundleId: string }
  | { state: "helper-exited"; code: number | null }
  | { state: "helper-failed" };

export type ObservationDeps = {
  spawn(): HelperChild;
  onStatus?(status: ObservationStatus): void;
  /** Never receives content text. */
  diagnostic?(message: string): void;
};

// Keep in sync with Browsers.known in native/observer/Sources/Observer/Core/Scope.swift.
const BROWSERS = new Set([
  "com.apple.Safari", "com.apple.SafariTechnologyPreview", "com.google.Chrome", "org.chromium.Chromium",
  "org.mozilla.firefox", "company.thebrowser.Browser", "com.microsoft.edgemac", "com.brave.Browser",
  "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
]);
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;
const MAX_LINE = 65_536;

const bundleId = z.string().regex(BUNDLE_ID);
const HelperLineSchema = z.union([
  z.strictObject({
    type: z.literal("event"),
    bundleId,
    windowId: z.string().min(1).max(64),
    siteOrigin: z.string().exactOptional(),
    text: z.string().min(1).max(12_000),
    capturedAt: z.iso.datetime(),
    grantVersion: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  z.strictObject({ type: z.literal("status"), status: z.enum(["ready", "permission-missing", "paused"]) }),
  z.strictObject({ type: z.literal("status"), status: z.literal("unsupported-app"), bundleId }),
]);

/**
 * Selectors are `bundleId` for an app or `bundleId|origin` for one allowed site in a browser,
 * where origin is a normalized http(s) origin. Anything else throws: an unclear selection grants nothing.
 */
function scopeOf(grant: SourceGrant): Map<string, Set<string>> {
  const scope = new Map<string, Set<string>>();
  for (const selector of grant.selectors) {
    const [id = "", origin, ...rest] = selector.split("|");
    if (!BUNDLE_ID.test(id) || rest.length > 0) throw new Error("Invalid observation selector");
    const origins = scope.get(id) ?? new Set<string>();
    if (origin !== undefined) {
      let url: URL;
      try {
        url = new URL(origin);
      } catch {
        throw new Error("Invalid observation selector");
      }
      if (!/^https?:$/.test(url.protocol) || url.origin !== origin) throw new Error("Invalid observation selector");
      origins.add(origin);
    }
    scope.set(id, origins);
  }
  return scope;
}

function inScope(event: ObservationEvent, grant: SourceGrant, scope: Map<string, Set<string>>): boolean {
  if (event.grantVersion !== grant.version) return false;
  const origins = scope.get(event.bundleId);
  if (!origins) return false;
  // A plain app has no origin; a browser is read only on a listed origin, never on an unknown one.
  if (origins.size === 0) return event.siteOrigin === undefined && !BROWSERS.has(event.bundleId);
  return event.siteOrigin !== undefined && origins.has(event.siteOrigin);
}

type Running = { disposed: boolean; paused: boolean; send(message: object): void; dispose(): void };
let current: Running | undefined;

/** Starts one helper for the single active observation grant; resolves to a disposer that invalidates in-flight events. */
export async function startObservation(
  grants: SourceGrant[],
  emit: (event: ObservationEvent) => void,
  deps: ObservationDeps,
): Promise<() => void> {
  current?.dispose();
  const active = grants.filter((g) => g.kind === "observation" && g.state === "active" && g.read);
  if (active.length > 1) throw new Error("Only one observation grant can be active");
  const grant = active[0];
  if (!grant) return () => {};
  const scope = scopeOf(grant); // before spawning: an invalid selection starts nothing

  const diagnostic = (message: string) =>
    deps.diagnostic ? deps.diagnostic(message) : console.warn(`observation: ${message}`);
  const child = deps.spawn();
  let exited = false;
  const running: Running = {
    disposed: false,
    paused: false,
    send: (message) => {
      if (!exited) child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    dispose: () => {
      if (running.disposed) return;
      running.disposed = true; // checked on every line, so nothing queued or in flight can emit
      running.send({ type: "stop" });
      child.stdin.end();
      child.kill();
      if (current === running) current = undefined;
    },
  };
  current = running;
  const status = (s: ObservationStatus) => {
    if (!running.disposed) deps.onStatus?.(s);
  };

  child.stdin.on("error", () => diagnostic("helper input closed"));
  child.once("exit", (code) => {
    exited = true;
    status({ state: "helper-exited", code });
  });
  child.once("error", () => {
    exited = true;
    status({ state: "helper-failed" });
  });
  createInterface({ input: child.stderr }).on("line", (line) => diagnostic(`helper: ${line.slice(0, 200)}`));
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (running.disposed || exited) return;
    if (line.length > MAX_LINE) return diagnostic("helper line too long");
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return diagnostic("malformed helper line");
    }
    const parsed = HelperLineSchema.safeParse(raw);
    // Codes and paths only: zod messages could quote received values.
    if (!parsed.success) {
      return diagnostic(`invalid helper line: ${parsed.error.issues.map((i) => `${i.code}@${i.path.join(".")}`).join(", ")}`);
    }
    const data = parsed.data;
    if (data.type === "status") {
      return status(data.status === "unsupported-app" ? { state: data.status, bundleId: data.bundleId } : { state: data.status });
    }
    if (running.paused) return;
    const event: ObservationEvent = {
      bundleId: data.bundleId,
      windowId: data.windowId,
      ...(data.siteOrigin !== undefined ? { siteOrigin: data.siteOrigin } : {}),
      text: data.text,
      capturedAt: data.capturedAt,
      grantVersion: data.grantVersion,
      truncated: data.truncated,
    };
    if (!inScope(event, grant, scope)) return diagnostic("event outside the current grant dropped");
    emit(event);
  });

  running.send({
    type: "scope",
    grantVersion: grant.version,
    bundles: [...scope].map(([id, origins]) => (origins.size ? { bundleId: id, origins: [...origins] } : { bundleId: id })),
  });
  return running.dispose;
}

/** Stops future reads. Retained observations stay until deleteRetainedObservations. */
export async function pauseObservation(): Promise<void> {
  if (!current || current.paused) return;
  current.paused = true;
  current.send({ type: "pause" });
}

/** Deleting retained excerpts is separate from pausing; the store owns the data. */
export async function deleteRetainedObservations(
  sourceId: SourceId,
  deleteStored: (sourceId: SourceId) => Promise<void>,
): Promise<void> {
  await deleteStored(sourceId);
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * The observation grant as a local source for the registry: accepted events become evidence in the
 * encrypted outbox (sent only under that source's cloud consent), helper status becomes freshness.
 */
export async function watchObservation(
  grant: SourceGrant,
  emit: (evidence: Evidence) => void,
  deps: Omit<ObservationDeps, "onStatus"> & { onStatus?(status: SourceStatus): void },
): Promise<WatchHandle> {
  const known = new Map<string, string>(); // externalId -> version, so an unchanged window is one record
  let status: SourceStatus = { freshness: "stale", reason: "starting", files: 0, issues: [] };
  const set = (reason: string | null) => {
    status = reason ? { freshness: "stale", reason, files: known.size, issues: [] } : { freshness: "current", files: known.size, issues: [] };
    deps.onStatus?.(status);
  };
  const dispose = await startObservation(
    [grant],
    (event) => {
      const externalId = `${event.bundleId}${event.siteOrigin ? `|${event.siteOrigin}` : ""}#${event.windowId}`;
      const version = sha256(event.text);
      if (known.get(externalId) === version) return;
      known.set(externalId, version);
      status = { ...status, files: known.size };
      emit({
        id: EvidenceIdSchema.parse(sha256(`${grant.id}\0${externalId}\0${version}`).slice(0, 32)),
        ownerId: grant.ownerId,
        sourceId: grant.id,
        externalId,
        version,
        text: event.text,
        occurredAt: event.capturedAt,
        receivedAt: new Date().toISOString(),
        projectIds: [...grant.projectIds],
        grantVersion: event.grantVersion,
        freshness: "current",
        origin: "live",
      });
    },
    { ...deps, onStatus: (s) => set(s.state === "ready" ? null : s.state) },
  );
  // The helper follows native app events itself; there is nothing to rescan on wake.
  return Object.assign(dispose, { status: () => status, ready: Promise.resolve(), reconcile: async () => {} });
}
