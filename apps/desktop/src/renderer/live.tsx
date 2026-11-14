// Thin containers: Convex subscriptions (pushed, never polled) and preload calls mapped onto the
// presentational screens. Owner identity is never sent from here; Convex reads it from the token.
import { useAction, useConvex, useConvexConnectionState, useMutation, useQueries, useQuery } from "convex/react";
import { Component, createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../../../../convex/_generated/api";
import type { LocalSourceView } from "../main/source-watch";
import { Connections, type LocalKind } from "./Connections";
import { MemoryView } from "./MemoryView";
import type { Commitment, Evidence, Honest, PetState, Prepared, ProjectSummary, SourceRow } from "./model";
import { Panel } from "./Panel";
import { Pet } from "./Pet";
import { ProjectView, type EditorActions, type RevisionOutcome } from "./ProjectView";
import { reason, StateNote } from "./ui";

// ---- Cloud session: one per window.

type Cloud = { signedIn: boolean | null; ready: boolean; honest: Honest | null; signIn(): Promise<void>; signingIn: boolean };
const CloudContext = createContext<Cloud | null>(null);

export function useCloud(): Cloud {
  const cloud = useContext(CloudContext);
  if (!cloud) throw new Error("useCloud outside CloudProvider");
  return cloud;
}

/** Signs this window's Convex client in with the main process's short-lived token and states where it stands. */
export function CloudProvider({ children }: { children: ReactNode }) {
  const convex = useConvex();
  const connection = useConvexConnectionState();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [auth, setAuth] = useState<"checking" | "accepted" | "rejected">("checking");
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    window.companion.authStatus().then(
      (s) => setSignedIn(s.signedIn),
      () => setSignedIn(false),
    );
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    convex.setAuth(
      ({ forceRefreshToken }) => window.companion.idToken(forceRefreshToken),
      (accepted) => setAuth(accepted ? "accepted" : "rejected"),
    );
    return () => convex.clearAuth();
  }, [convex, signedIn]);

  const signIn = useCallback(async () => {
    setSigningIn(true);
    try {
      setSignedIn((await window.companion.signIn()).signedIn);
    } finally {
      setSigningIn(false);
    }
  }, []);

  let honest: Honest | null = null;
  if (signedIn === null) honest = { kind: "loading" };
  else if (!signedIn) honest = { kind: "not-signed-in", detail: "Sign in to see your projects." };
  else if (!connection.isWebSocketConnected)
    honest = connection.hasEverConnected
      ? { kind: "stale", detail: "Cloud unreachable. Captures still save on this Mac; projects return with the connection." }
      : { kind: "loading", detail: "Connecting to the cloud…" };
  else if (auth === "checking") honest = { kind: "loading", detail: "Checking your sign-in with the cloud…" };
  else if (auth === "rejected") honest = { kind: "missing-access", detail: "The cloud did not accept this sign-in. Sign in again." };

  const ready = signedIn === true && auth === "accepted";
  return <CloudContext.Provider value={{ signedIn, ready, honest, signIn, signingIn }}>{children}</CloudContext.Provider>;
}

/** A failed subscription shows as Needs retry inside its block; Try again is the user's choice. */
export class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(err: unknown) {
    return { error: reason(err) };
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="screen">
        <StateNote state={{ kind: "needs-retry", detail: this.state.error }}>
          <button type="button" className="text-button" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </StateNote>
      </div>
    );
  }
}

// ---- Shared mappers.

type PreparedRow = { work?: Prepared["work"]; status: Prepared["status"]; lastError?: string; updatedAt: string } | null;
const toPrepared = (row: PreparedRow | undefined | Error): Prepared | undefined => {
  if (row instanceof Error) return { status: "needs-retry", updatedAt: "", lastError: reason(row) };
  if (!row) return undefined;
  return { status: row.status, updatedAt: row.updatedAt, ...(row.work ? { work: row.work } : {}), ...(row.lastError ? { lastError: row.lastError } : {}) };
};
type EvidenceRow = { id: string; text: string; occurredAt: string; sourceUrl?: string; freshness: string; origin: string };
/** Illustrative records never reach the product UI. */
const toEvidence = (rows: EvidenceRow[] | undefined): Evidence[] =>
  (rows ?? [])
    .filter((r) => r.origin !== "illustrative")
    .map((r) => ({
      id: r.id,
      text: r.text,
      occurredAt: r.occurredAt,
      ...(r.sourceUrl ? { sourceUrl: r.sourceUrl } : {}),
      freshness: r.freshness === "current" || r.freshness === "stale" ? r.freshness : "unknown",
    }));

/** Every project's prepared work and commitments, one subscription each, for Today and the rail. */
export function useProjectSummaries(projects: { id: string; name: string }[] | undefined): ProjectSummary[] | null {
  const queries = useMemo(
    () =>
      Object.fromEntries(
        (projects ?? []).flatMap((p) => [
          [`w:${p.id}`, { query: api.prepare.getPreparedWork, args: { projectId: p.id } }],
          [`c:${p.id}`, { query: api.prepare.listCommitments, args: { projectId: p.id } }],
        ]),
      ),
    [projects],
  );
  const results = useQueries(queries);
  if (!projects) return null;
  return projects.map((p) => {
    const commitments = results[`c:${p.id}`];
    const prepared = toPrepared(results[`w:${p.id}`] as PreparedRow | undefined | Error);
    return { id: p.id, name: p.name, commitments: Array.isArray(commitments) ? (commitments as Commitment[]) : [], ...(prepared ? { prepared } : {}) };
  });
}

/** Done = every commitment of yours in the project is done (and there was at least one). */
export function completionOf(commitments: Commitment[] | undefined): string | null {
  const mine = (commitments ?? []).filter((c) => c.ownership === "user");
  const done = mine.filter((c) => c.state === "user-reported-done" || c.state === "verified-done");
  return mine.length > 0 && done.length === mine.length ? (done.at(-1)?.text ?? null) : null;
}

// ---- Project.

const outcome = (r: { status: "applied" | "conflict"; changeSummary: string; undoRevision?: string; artifact: { revision: string } }): RevisionOutcome => ({
  status: r.status,
  changeSummary: r.changeSummary,
  revision: r.artifact.revision,
  ...(r.undoRevision ? { undoRevision: r.undoRevision } : {}),
});

export function ProjectLive(props: { projectId: string; name: string; isFocus: boolean; mode?: "help" | "improve"; onMakeFocus(): void; onStop(): void }) {
  const { projectId } = props;
  const prepared = useQuery(api.prepare.getPreparedWork, { projectId });
  const commitments = useQuery(api.prepare.listCommitments, { projectId });
  const evidence = useQuery(api.evidence.listCurrentEvidence, { projectId });
  const artifact = useQuery(api.artifacts.getArtifact, { projectId });
  const prepare = useAction(api.prepare.prepareProject);
  const create = useMutation(api.artifacts.createFromPrepared);
  const saveEdit = useMutation(api.artifacts.saveEdit);
  const revise = useAction(api.artifacts.reviseArtifact);
  const undo = useMutation(api.artifacts.undoRevision);
  const apply = useMutation(api.artifacts.applySuggestion);
  const dismiss = useMutation(api.artifacts.dismissSuggestion);

  const editor: EditorActions = {
    create: async () => void (await create({ projectId })),
    save: async (text, baseRevision) => outcome(await saveEdit({ artifactId: artifact!.id, baseRevision, text })),
    revise: async (instruction, baseRevision) => outcome(await revise({ artifactId: artifact!.id, baseRevision, instruction })),
    undo: async (expectedCurrent, undoRevision) => outcome(await undo({ artifactId: artifact!.id, expectedCurrent, undoRevision })),
    applySuggestion: async (suggestionId, baseRevision) => outcome(await apply({ suggestionId, baseRevision })),
    dismissSuggestion: async (suggestionId) => void (await dismiss({ suggestionId })),
  };

  const loadedPrepared = toPrepared(prepared);
  return (
    <ProjectView
      name={props.name}
      isFocus={props.isFocus}
      {...(props.mode ? { mode: props.mode } : {})}
      {...(loadedPrepared ? { prepared: loadedPrepared } : {})}
      {...(prepared === undefined ? { preparedState: { kind: "loading" } as Honest } : {})}
      evidence={toEvidence(evidence)}
      commitments={commitments ?? null}
      artifact={artifact === undefined ? undefined : artifact && { id: artifact.id, revision: artifact.revision, text: artifact.text, userEdited: artifact.userEdited, suggestions: artifact.suggestions }}
      editor={editor}
      onMakeFocus={props.onMakeFocus}
      onPrepare={async () => void (await prepare({ projectId }))}
      onStop={props.onStop}
    />
  );
}

// ---- Memory.

export function MemoryLive({ projects, projectId, onSelectProject }: { projects: { id: string; name: string }[]; projectId?: string; onSelectProject(id: string): void }) {
  const args = projectId ? { projectId } : "skip";
  const facts = useQuery(api.memory.listMemory, args);
  const withheld = useQuery(api.memory.listWithheld, args);
  const evidence = useQuery(api.evidence.listCurrentEvidence, args);
  const remember = useMutation(api.memory.remember);
  const forget = useMutation(api.memory.forget);
  const allow = useMutation(api.memory.allowRelearning);
  const scoped = (scope: "project" | "global") => (scope === "project" && projectId ? { projectId } : {});

  return (
    <MemoryView
      projects={projects}
      {...(projectId ? { projectId } : {})}
      {...(projectId && facts === undefined ? { state: { kind: "loading" } as Honest } : {})}
      facts={facts ?? []}
      withheld={withheld ?? []}
      evidence={toEvidence(evidence)}
      onSelectProject={onSelectProject}
      onCorrect={async (fact, value) =>
        void (await remember({ ...scoped(fact.scope), key: fact.key, value, evidenceIds: fact.evidenceIds, scope: fact.scope, explicitUserInstruction: true }))
      }
      onForget={async (fact) => void (await forget({ ...scoped(fact.scope), key: fact.key }))}
      onAllowRelearning={async (key) => void (await allow({ ...(projectId ? { projectId } : {}), key }))}
    />
  );
}

// ---- Connections.

const LOCAL: { kind: LocalKind; name: string; coverage: string }[] = [
  { kind: "obsidian", name: "Notes folder", coverage: "Markdown notes in one folder you pick: build orders, decisions, logs." },
  { kind: "claude-code", name: "Claude Code sessions", coverage: "Relevant excerpts from Claude Code session files in a folder you pick. Not Claude Desktop projects." },
  { kind: "codex", name: "Codex sessions", coverage: "Relevant excerpts from Codex session files in a folder you pick." },
];
const CLOUD: { provider: string; name: string; coverage: string }[] = [
  { provider: "slack", name: "Slack", coverage: "Selected channels and threads: commitments and who is waiting on whom." },
  { provider: "gmail", name: "Gmail", coverage: "Selected project labels and threads." },
  { provider: "notion", name: "Notion", coverage: "Pages you share with the app, and the outcome log you choose." },
  { provider: "canvas", name: "Canvas", coverage: "Selected courses and their real due dates. Checked when you connect and when you press Refresh." },
  { provider: "outlook-mail", name: "Outlook mail", coverage: "The threads or folders you select." },
  { provider: "outlook-calendar", name: "Outlook calendar", coverage: "Selected calendars, so preparation never lands in a meeting." },
];
const NOT_BUILT = "Connecting this account from the app is not built yet.";

export function ConnectionsLive({ projects }: { projects: { id: string; name: string }[] | null }) {
  const cloud = useCloud();
  const connections = useQuery(api.connections.listConnections, cloud.ready ? {} : "skip");
  const [local, setLocal] = useState<LocalSourceView[] | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // Read once, then again after each change this screen makes: an event, not a timer.
  const reload = useCallback(
    () =>
      window.companion.listSources().then(
        (rows) => (setLocal(rows), setLocalError(null)),
        (err: unknown) => setLocalError(reason(err)),
      ),
    [],
  );
  useEffect(() => {
    if (cloud.signedIn) void reload();
  }, [cloud.signedIn, reload]);
  const after = (action: Promise<unknown>) => action.then(reload);

  const rows: SourceRow[] = [];
  for (const def of LOCAL) {
    const added = (local ?? []).filter((s) => s.kind === def.kind);
    for (const s of added) {
      rows.push({
        id: s.id,
        name: `${def.name}: ${s.name}`,
        coverage: s.coverage,
        group: "mac",
        state: s.state === "paused" ? "paused" : "on",
        cloudProcessing: s.cloudProcessing,
        ...(s.freshness === "stale" ? { status: { kind: "stale", detail: s.reason ?? "Not reading right now" } as Honest } : {}),
      });
    }
    if (added.length === 0) rows.push({ id: def.kind, name: def.name, coverage: def.coverage, group: "mac", state: "off" });
  }
  for (const def of CLOUD) {
    const c = connections?.find((x) => x.provider === def.provider);
    if (!c) {
      rows.push({
        id: def.provider,
        name: def.name,
        coverage: def.coverage,
        group: "cloud",
        state: "unavailable",
        unavailableReason: cloud.honest ? (cloud.honest.kind === "not-signed-in" ? "Sign in first." : "Waiting for the cloud.") : NOT_BUILT,
      });
      continue;
    }
    const status: Honest =
      c.availability === "connected"
        ? c.lastCheckedAt
          ? { kind: "last-checked", at: c.lastCheckedAt }
          : { kind: "partial", detail: "Connected; not checked yet" }
        : c.availability === "stale"
          ? { kind: "stale", ...(c.lastCheckedAt ? { at: c.lastCheckedAt } : {}) }
          : c.availability === "missing-access"
            ? { kind: "missing-access", ...(c.lastError ? { detail: c.lastError } : {}) }
            : { kind: "needs-retry", ...(c.lastError ? { detail: c.lastError } : {}) };
    rows.push({ id: c.sourceId, name: def.name, coverage: def.coverage, group: "cloud", state: "on", status });
  }
  rows.push({
    id: "observation",
    name: "Selected apps",
    coverage: "Visible text from apps you choose. No screenshots.",
    group: "optional",
    state: "unavailable",
    unavailableReason: "Not available in this build.",
  });

  const addBlocked = !cloud.signedIn
    ? "Sign in first."
    : localError
      ? localError
      : projects === null
        ? "Waiting for your projects from the cloud, so the source can belong to one."
        : projects.length === 0
          ? "Add a project on Today first, so the source can belong to it."
          : undefined;

  return (
    <Connections
      rows={rows}
      projects={projects ?? []}
      {...(addBlocked ? { addBlocked } : {})}
      onAdd={(kind, projectId) => after(window.companion.chooseSource(kind, [projectId]))}
      onPause={(id) => after(window.companion.pauseSource(id))}
      onResume={(id) => after(window.companion.resumeSource(id))}
      onRevoke={(id) => after(window.companion.revokeSource(id))}
      onSetCloud={(id, enabled) => after(window.companion.setCloudProcessing(id, enabled))}
    />
  );
}

// ---- Pet and panel windows.

/** The focus project's prepared work and completion, for the pet and the panel. */
function useCompanionContext(projectIdOverride: string | null) {
  const cloud = useCloud();
  const focus = useQuery(api.projects.getFocus, cloud.ready ? {} : "skip");
  const projects = useQuery(api.projects.listProjects, cloud.ready ? {} : "skip");
  const projectId = projectIdOverride ?? focus?.projectId;
  const args = cloud.ready && projectId ? { projectId } : "skip";
  const prepared = useQuery(api.prepare.getPreparedWork, args);
  const commitments = useQuery(api.prepare.listCommitments, args);
  const done = completionOf(commitments as Commitment[] | undefined);
  const petState: PetState = done ? "done" : "idle";
  return { cloud, projectId, name: projects?.find((p) => p.id === projectId)?.name, prepared: toPrepared(prepared), done, petState };
}

export function PetLive() {
  const { petState } = useCompanionContext(null);
  return <Pet state={petState} onOpen={() => void window.companion.openPanel()} />;
}

export function PanelLive() {
  const [shown, setShown] = useState<{ projectId: string | null; at: number }>({ projectId: null, at: 0 });
  useEffect(() => window.companion.onPanelShow((projectId) => setShown({ projectId, at: Date.now() })), []);
  const ctx = useCompanionContext(shown.projectId);
  const work = ctx.prepared?.work;
  const state: Honest | undefined =
    ctx.cloud.honest ??
    (!ctx.projectId
      ? { kind: "empty", detail: "Pick a project in the app to make it your focus." }
      : ctx.prepared === undefined
        ? { kind: "empty", detail: "Nothing prepared here yet." }
        : ctx.prepared.status === "needs-retry"
          ? { kind: "needs-retry", detail: "The last preparation failed." }
          : undefined);
  const close = () => void window.companion.closePanel();
  return (
    <Panel
      key={shown.at}
      petState={ctx.petState}
      {...(ctx.name ? { projectName: ctx.name } : {})}
      {...(work?.title ? { context: work.title } : {})}
      {...(work?.nextAction ? { nextAction: work.nextAction } : {})}
      {...(state ? { state } : {})}
      {...(ctx.done ? { completion: { done: ctx.done, ...(work?.nextAction ? { next: work.nextAction } : {}) } } : {})}
      onOpenApp={() => void window.companion.openApp(ctx.projectId ?? undefined)}
      onStop={close}
      onClose={close}
    />
  );
}
