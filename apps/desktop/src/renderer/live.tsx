// Thin containers: Convex subscriptions (pushed, never polled) and preload calls mapped onto the
// presentational screens. Owner identity is never sent from here; Convex reads it from the token.
import { useAction, useConvex, useConvexConnectionState, useMutation, useQueries, useQuery } from "convex/react";
import { Component, createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { LocalSourceView } from "../main/source-watch";
import type { HoldKeyStatus, PanelShowing } from "../preload/index";
import { Connections, type CloudActions, type LocalKind, type ShortcutStatus } from "./Connections";
import { MemoryView } from "./MemoryView";
import { cloudRow, permissionMissing, tarsCalendar, type Brief, type CloudProvider, type Commitment, type Evidence, type Honest, type NudgeChoice, type PetState, type Prepared, type ProjectSummary, type Reentry, type SessionEvent, type SessionState, type SourceRow, type Tradeoff } from "./model";
import { Panel } from "./Panel";
import { Pet } from "./Pet";
import { contentHash } from "../../../../packages/domain/src/actions";
import type { ActingActions } from "./Act";
import { ProjectView, type EditorActions, type RevisionOutcome } from "./ProjectView";
import { Schedule } from "./Schedule";
import { TarsCalendar } from "./TarsCalendar";
import { reason, SOURCE_NAME, StateNote } from "./ui";

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

// ---- Today: the brief service, re-entry and the explicit session.

type Connection = { sourceId: string; provider: string; lastCheckedAt?: string };
type BriefRow = {
  key: string;
  kind: "morning" | "evening";
  preparedAt: number;
  delivered: boolean;
  brief: Omit<Brief, "key" | "kind" | "preparedAt" | "delivered" | "stale"> & { staleSourceIds: string[] };
  tradeoffs: Tradeoff[];
};

const toBrief = (row: BriefRow, connections: Connection[] | undefined): Brief => {
  const { staleSourceIds, ...brief } = row.brief;
  const stale = new Map<string, Brief["stale"][number]>();
  for (const id of staleSourceIds) {
    const c = connections?.find((x) => x.sourceId === id);
    // Local sources have no cloud connection row; their own freshness shows in Connections.
    const entry = c ? { name: SOURCE_NAME[c.provider] ?? c.provider, ...(c.lastCheckedAt ? { lastCheckedAt: c.lastCheckedAt } : {}) } : { name: "A source on this Mac" };
    stale.set(entry.name, entry);
  }
  return { ...brief, key: row.key, kind: row.kind, preparedAt: row.preparedAt, delivered: row.delivered, stale: [...stale.values()] };
};

// shortcut: "days away" is a fixed two days since the previous visit; tune from use.
const AWAY_MS = 2 * 24 * 60 * 60 * 1000;
// One recorded return per window load, even under StrictMode's double effects.
let returnRecorded = false;
let settingsRequested = false;

/** Today's brief (the evening recap when it is the newer one), re-entry after days away, and the one open tradeoff. */
export function useToday({ recordReturn }: { recordReturn: boolean }) {
  const cloud = useCloud();
  const args = cloud.ready ? {} : "skip";
  const morning = useQuery(api.briefs.getPendingBrief, cloud.ready ? { kind: "morning" } : "skip");
  const evening = useQuery(api.briefs.getPendingBrief, cloud.ready ? { kind: "evening" } : "skip");
  const reentryRow = useQuery(api.briefs.getReentry, args);
  const connections = useQuery(api.connections.listConnections, args);
  const setSettings = useMutation(api.briefs.setAttentionSettings);
  const handleReturn = useMutation(api.briefs.handleReturn);
  const markDelivered = useMutation(api.briefs.markDelivered);
  const resolveTradeoff = useMutation(api.briefs.resolveTradeoff);
  const nudges = useQuery(api.briefs.listNudgeOffers, args);
  const respondToNudge = useMutation(api.briefs.respondToNudge);
  const [returned, setReturned] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // No settings yet (getReentry answers null): briefs need the Mac's timezone, once. Then record this visit.
  useEffect(() => {
    if (!recordReturn || !cloud.ready || reentryRow === undefined) return;
    if (reentryRow === null) {
      if (settingsRequested) return;
      settingsRequested = true;
      setSettings({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }).catch((err: unknown) => setError(reason(err)));
      return;
    }
    if (returnRecorded) return setReturned(true);
    returnRecorded = true;
    handleReturn({ panelOpen: false }).then(
      () => setReturned(true),
      (err: unknown) => setError(reason(err)),
    );
  }, [recordReturn, cloud.ready, reentryRow, setSettings, handleReturn]);

  const rows = morning === undefined || evening === undefined ? undefined : [morning, evening].filter((r) => r !== null);
  const newest = rows?.sort((a, b) => b.preparedAt - a.preparedAt)[0];
  const brief: Brief | null | undefined = rows === undefined ? undefined : newest ? toBrief(newest as BriefRow, connections) : null;
  const away = returned && reentryRow?.since && Date.now() - Date.parse(reentryRow.since) >= AWAY_MS;
  const reentry: Reentry | undefined =
    away && reentryRow?.since
      ? {
          since: reentryRow.since,
          changed: reentryRow.changed,
          changedCount: reentryRow.changedCount,
          urgent: reentryRow.urgent,
          ...(reentryRow.recommendedAction ? { recommendedAction: reentryRow.recommendedAction } : {}),
          ...(reentryRow.reason ? { reason: reentryRow.reason } : {}),
        }
      : undefined;
  const tradeoff = (morning?.tradeoffs ?? evening?.tradeoffs)?.[0];
  const onBriefShown = useCallback((key: string) => void markDelivered({ key, channel: "panel" }).catch((err: unknown) => setError(reason(err))), [markDelivered]);
  return {
    brief,
    reentry,
    tradeoff,
    nudge: nudges?.[0],
    /** Closes the offer; resolves to the project whose draft "Finish it together" opens. */
    onNudge: async (nudgeId: string, choice: NudgeChoice) => (await respondToNudge({ nudgeId: nudgeId as Id<"nudges">, choice })).projectId,
    error,
    onBriefShown,
    onResolveTradeoff: async (commitmentId: string, choice: "keep" | "defer" | "renegotiate") =>
      void (await resolveTradeoff({ commitmentId: commitmentId as Id<"commitments">, choice })),
  };
}

/** Start / Break / Back are explicit and recorded; Stop records a stop and starts nothing. */
export function useSession() {
  const record = useMutation(api.briefs.recordSessionEvent);
  const [state, setState] = useState<SessionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const after: Record<SessionEvent, SessionState> = { start: "working", resume: "working", break: "break", stop: "idle" };
  const onEvent = (event: SessionEvent) => {
    setError(null);
    setState(after[event]); // the user's click wins on screen; a failed record is said, not hidden
    record({ kind: event }).catch((err: unknown) => setError(`Not recorded: ${reason(err)}`));
  };
  return { state, error, onEvent };
}

// ---- Schedule and TARS's calendar.

/** The user's meetings and real due dates, from the pending morning brief. */
export function ScheduleLive({ projects }: { projects: { id: string; name: string }[] | null }) {
  const cloud = useCloud();
  const morning = useQuery(api.briefs.getPendingBrief, cloud.ready ? { kind: "morning" } : "skip");
  const schedule = useQuery(api.briefs.getSchedule, cloud.ready ? {} : "skip");
  return (
    <Schedule
      brief={morning === undefined ? undefined : morning && { hard: morning.brief.hard, preparedAt: morning.preparedAt }}
      {...(schedule ? { nextBriefAt: schedule.morningAt } : {})}
      {...(cloud.honest ? { cloud: cloud.honest } : {})}
      now={Date.now()}
      nameOf={(id) => projects?.find((p) => p.id === id)?.name}
    />
  );
}

/** What TARS does on its own, from the brief schedule, the pending briefs, prepared work and source health. */
export function CalendarLive({ projects }: { projects: ProjectSummary[] | null }) {
  const cloud = useCloud();
  const args = cloud.ready ? {} : "skip";
  const schedule = useQuery(api.briefs.getSchedule, args);
  const morning = useQuery(api.briefs.getPendingBrief, cloud.ready ? { kind: "morning" } : "skip");
  const evening = useQuery(api.briefs.getPendingBrief, cloud.ready ? { kind: "evening" } : "skip");
  const connections = useQuery(api.connections.listConnections, args);
  const now = Date.now();
  const loaded = schedule !== undefined && morning !== undefined && evening !== undefined && connections !== undefined && projects !== null;
  return (
    <TarsCalendar
      calendar={
        loaded
          ? tarsCalendar({
              now,
              schedule,
              briefs: [morning, evening].flatMap((b) => (b ? [{ kind: b.kind, preparedAt: b.preparedAt, delivered: b.delivered }] : [])),
              projects,
              // Only live grants: a paused or revoked source is not TARS's to check.
              sources: connections
                .filter((c) => c.state === "active")
                .map((c) => ({ name: SOURCE_NAME[c.provider] ?? c.provider, availability: c.availability, ...(c.lastCheckedAt ? { lastCheckedAt: c.lastCheckedAt } : {}), ...(c.lastError ? { lastError: c.lastError } : {}) })),
            })
          : undefined
      }
      {...(cloud.honest ? { cloud: cloud.honest } : {})}
      now={now}
    />
  );
}

// ---- Project.

const MAILBOXES = ["gmail", "outlook-mail"];

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
  const receipts = useQuery(api.actions.listReceipts, { projectId });
  const executeIntent = useAction(api.actions.executeIntent);
  const reconcile = useAction(api.actions.reconcileAction);
  const appendLog = useAction(api.actions.appendOutcomeLog);
  const setLog = useMutation(api.actions.setLogDestination);
  const logDestination = useQuery(api.actions.getLogDestination, { projectId });
  const reportDone = useMutation(api.actions.reportDone);
  const connections = useQuery(api.connections.listConnections, {});
  const gmailSendConsent = useMutation(api.connectors.gmail.startSendConsent);
  const outlookSendConsent = useMutation(api.connectors.outlook.startSendConsent);
  const mailboxes = (connections ?? []).filter((c) => MAILBOXES.includes(c.provider));
  // Notes folders on this Mac, read once: a log note is picked inside one of them.
  const [notes, setNotes] = useState<{ id: string; name: string; cloudProcessing: boolean }[]>([]);
  useEffect(() => {
    window.companion.listSources().then(
      (rows) => setNotes(rows.filter((r) => r.kind === "obsidian" && r.state === "active").map((r) => ({ id: r.id, name: r.name, cloudProcessing: r.cloudProcessing }))),
      () => setNotes([]),
    );
  }, []);

  const acting: ActingActions = {
    execute: async (intent, saved) => {
      try {
        const result = await executeIntent({
          projectId,
          ...intent,
          artifactId: saved.artifactId,
          revision: saved.revision,
          contentHash: await contentHash(saved.text),
        });
        return "status" in result ? result : { status: "receipt", receipt: result };
      } catch (err) {
        // The backend refuses a send without the mailbox's separate send consent; that is a step, not a failure.
        if (reason(err) === "missing-send-permission") return { status: "missing-send-permission" };
        throw err;
      }
    },
    reconcile: async (actionId) => void (await reconcile({ actionId })),
    retryLog: async (actionId) => void (await appendLog({ actionId })),
    setLogDestination: async (kind, target) => void (await setLog({ projectId, kind, target })),
    notes: {
      sources: notes,
      designate: async (sourceId) => {
        const picked = await window.companion.designateLogNote(sourceId);
        return picked && { target: picked.target, name: picked.name };
      },
    },
    // Send consent is its own provider page, for exactly the mailbox that will send; it opens in the browser.
    sendConsent:
      mailboxes.length === 0
        ? { blocked: "Connect Gmail or Outlook mail in Connections first. Nothing was sent." }
        : {
            mailboxes: mailboxes.map((c) => ({
              name: SOURCE_NAME[c.provider] ?? c.provider,
              start: async () =>
                window.companion.openExternalAuth(await (c.provider === "gmail" ? gmailSendConsent : outlookSendConsent)({ sourceId: c.sourceId })),
            })),
          },
  };

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
      receipt={receipts === undefined ? undefined : (receipts.at(-1) ?? null)}
      acting={acting}
      logDestination={logDestination}
      onReportDone={async (taskId) => void (await reportDone({ taskId }))}
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
  const accept = useMutation(api.memory.acceptWithheld);
  const dismissWithheld = useMutation(api.memory.dismissWithheld);
  const allowRelearning = useMutation(api.memory.allowRelearning);
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
      onAllowRelearning={async (fact) => void (await allowRelearning({ ...scoped(fact.scope), key: fact.key }))}
      onAccept={async (item) => void (await accept({ id: item.id }))}
      onDismiss={async (item) => void (await dismissWithheld({ id: item.id }))}
    />
  );
}

// ---- Connections.

const LOCAL: { kind: LocalKind; name: string; coverage: string }[] = [
  { kind: "obsidian", name: "Notes folder", coverage: "Markdown notes in one folder you pick: build orders, decisions, logs." },
  { kind: "claude-code", name: "Claude Code sessions", coverage: "Relevant excerpts from Claude Code session files in a folder you pick. Not Claude Desktop projects." },
  { kind: "codex", name: "Codex sessions", coverage: "Relevant excerpts from Codex session files in a folder you pick." },
];
const CLOUD: { provider: CloudProvider; name: string; coverage: string }[] = [
  { provider: "slack", name: "Slack", coverage: "Selected channels and threads: commitments and who is waiting on whom." },
  { provider: "gmail", name: "Gmail", coverage: "Selected project labels and threads." },
  { provider: "notion", name: "Notion", coverage: "Pages you share with the app, and the outcome log you choose." },
  { provider: "canvas", name: "Canvas", coverage: "Selected courses and their real due dates. Checked when you connect and when you press Refresh." },
  { provider: "outlook-mail", name: "Outlook mail", coverage: "The threads or folders you select." },
  { provider: "outlook-calendar", name: "Outlook calendar", coverage: "Selected calendars, so preparation never lands in a meeting." },
];
// The Convex HTTP actions (provider webhooks) are served from the deployment's .site origin.
const SITE_URL = import.meta.env.CONVEX_URL.replace(/\.convex\.cloud$/, ".convex.site");

export function ConnectionsLive({ projects }: { projects: { id: string; name: string }[] | null }) {
  const cloud = useCloud();
  const connections = useQuery(api.connections.listConnections, cloud.ready ? {} : "skip");
  const setGrant = useMutation(api.evidence.setGrant);
  const connectSlack = useAction(api.connectors.slack.connect);
  const connectNotion = useAction(api.connectors.notion.connect);
  const connectCanvas = useAction(api.connectors.canvas.connect);
  const revealNotion = useAction(api.connectors.notion.revealVerificationToken);
  const refreshCanvas = useAction(api.connectors.canvas.refreshByUser);
  const refreshGmail = useAction(api.connectors.gmail.refresh);
  const refreshOutlook = useAction(api.connectors.outlook.refresh);
  const startGmail = useMutation(api.connectors.gmail.startConnect);
  const startOutlook = useMutation(api.connectors.outlook.startConnect);
  const setGrantState = useMutation(api.evidence.setGrantState);
  const [local, setLocal] = useState<LocalSourceView[] | null>(null);
  const [missingPermission, setPermissionMissing] = useState<Set<string>>(new Set());
  const [shortcut, setShortcut] = useState<ShortcutStatus | null>(null);
  const talkKey = useTalkKey();
  useEffect(() => {
    window.companion.shortcut.status().then(setShortcut, (err: unknown) => setShortcut({ accelerator: "The shortcut", registered: false, error: reason(err) }));
  }, []);
  // Observation status is pushed by the main process (status words only, never observed text).
  useEffect(
    () =>
      window.companion.observation.onStatus((event) =>
        setPermissionMissing((current) => {
          const next = new Set(current);
          if (permissionMissing(event)) next.add(event.sourceId);
          else next.delete(event.sourceId);
          return next;
        }),
      ),
    [],
  );
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
  const projectName = (id: string) => projects?.find((p) => p.id === id)?.name;
  for (const def of CLOUD) rows.push(cloudRow(def, connections ?? [], projectName));
  const observed = (local ?? []).filter((s) => s.kind === "observation" && s.state !== "revoked");
  for (const s of observed) {
    rows.push({
      id: s.id,
      name: `Selected apps: ${s.name}`,
      coverage: s.coverage,
      group: "optional",
      state: s.state === "paused" ? "paused" : "on",
      cloudProcessing: s.cloudProcessing,
      ...(missingPermission.has(s.id) ? { permissionMissing: true } : {}),
      ...(s.freshness === "stale" ? { status: { kind: "stale", detail: s.reason ?? "Not reading right now" } as Honest } : {}),
    });
  }
  if (observed.length === 0) {
    rows.push({ id: "observation", name: "Selected apps", coverage: "Visible text from apps and sites you name. No screenshots, no keystrokes.", group: "optional", state: "off" });
  }

  const addBlocked = !cloud.signedIn
    ? "Sign in first."
    : localError
      ? localError
      : projects === null
        ? "Waiting for your projects from the cloud, so the source can belong to one."
        : projects.length === 0
          ? "Add a project on Today first, so the source can belong to it."
          : undefined;

  const cloudBlocked = !cloud.ready
    ? cloud.honest?.kind === "not-signed-in"
      ? "Sign in first."
      : "Waiting for the cloud."
    : projects === null || projects.length === 0
      ? "Add a project on Today first, so the account can belong to it."
      : undefined;
  const cloudActions: CloudActions = {
    ...(cloudBlocked ? { blocked: cloudBlocked } : {}),
    onConnect: async (provider, form) => {
      const grant = {
        id: `${provider}-${crypto.randomUUID()}`,
        kind: provider,
        selectors: form.selectors,
        projectIds: [form.projectId],
        read: true,
        writeTargets: form.writeTargets,
        cloudProcessing: true,
        version: Date.now(),
        state: "active",
      };
      await setGrant(grant);
      try {
        const credential = form.credential ?? "";
        if (provider === "slack") await connectSlack({ sourceId: grant.id, botToken: credential });
        else if (provider === "notion") await connectNotion({ sourceId: grant.id, token: credential });
        else if (provider === "canvas") await connectCanvas({ sourceId: grant.id, baseUrl: form.baseUrl ?? "", token: credential });
        // OAuth: the provider's page opens in the system browser; the connection appears when its callback lands.
        else await window.companion.openExternalAuth(await (provider === "gmail" ? startGmail : startOutlook)({ sourceId: grant.id }));
      } catch (err) {
        // Never leave an active grant behind a failed connect; the original error is the one to show.
        await setGrant({ ...grant, selectors: [], writeTargets: [], read: false, version: grant.version + 1, state: "revoked" }).catch(() => undefined);
        throw err;
      }
    },
    onRefresh: async (row) => {
      if (row.provider === "canvas") await refreshCanvas({ sourceId: row.id });
      else if (row.provider === "gmail") await refreshGmail({ sourceId: row.id });
      else if (row.provider === "outlook-mail" || row.provider === "outlook-calendar") await refreshOutlook({ sourceId: row.id, kind: row.provider });
    },
    // The stored grant's next version: the change survives a reload and every window sees it.
    onPause: async (row) => void (await setGrantState({ sourceId: row.id, state: "paused" })),
    onResume: async (row) => void (await setGrantState({ sourceId: row.id, state: "active" })),
    onRevoke: async (row) => void (await setGrantState({ sourceId: row.id, state: "revoked" })),
    notionWebhookUrl: (sourceId) => `${SITE_URL}/notion/events?source=${encodeURIComponent(sourceId)}`,
    revealNotionToken: (sourceId) => revealNotion({ sourceId }),
  };

  return (
    <Connections
      rows={rows}
      cloud={cloudActions}
      observation={{
        onStart: (selectors, projectId) => after(window.companion.observation.start(selectors, [projectId])),
        onDeleteRetained: (id) => window.companion.observation.deleteRetained(id),
        onOpenAccessibility: () => window.companion.observation.openAccessibilitySettings(),
      }}
      shortcut={{ status: shortcut, onSet: async (accelerator) => setShortcut(await window.companion.shortcut.set(accelerator)) }}
      talkKey={{ status: talkKey, onOpenAccessibility: () => window.companion.talk.openAccessibilitySettings() }}
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

/** The held talk key's status: read once, then pushed by main when it changes (never polled). */
function useTalkKey() {
  const [status, setStatus] = useState<HoldKeyStatus | null>(null);
  useEffect(() => {
    let pushed = false;
    const stop = window.companion.talk.onKeyStatus((s) => ((pushed = true), setStatus(s)));
    window.companion.talk.keyStatus().then((s) => pushed || setStatus(s), () => undefined);
    return stop;
  }, []);
  return status;
}

/** The focus project's prepared work and completion, for the pet and the panel. */
function useCompanionContext(projectIdOverride: string | null) {
  const cloud = useCloud();
  const focus = useQuery(api.projects.getFocus, cloud.ready ? {} : "skip");
  const projects = useQuery(api.projects.listProjects, cloud.ready ? {} : "skip");
  const projectId = projectIdOverride ?? focus?.projectId;
  const args = cloud.ready && projectId ? { projectId } : "skip";
  const prepared = useQuery(api.prepare.getPreparedWork, args);
  const commitments = useQuery(api.prepare.listCommitments, args);
  const receipt = useQuery(api.actions.listReceipts, args)?.at(-1);
  const done = completionOf(commitments as Commitment[] | undefined);
  // Working is real: an instructed action of the focus project is in flight right now.
  const working = receipt?.state === "pending" || receipt?.state === "running";
  const petState: PetState = working ? "working" : done ? "done" : "idle";
  // The saved next step belongs to the focus project only, not to a project the panel was opened for.
  const step = projectId === focus?.projectId ? focus?.nextStep : undefined;
  return { cloud, projectId, name: projects?.find((p) => p.id === projectId)?.name, prepared: toPrepared(prepared), done, receipt, petState, step };
}

/** Tells main when the pointer enters or leaves this whole window (the pet or the panel); main decides what opens. */
function usePointerOver() {
  useEffect(() => {
    const root = document.documentElement;
    const enter = () => void window.companion.pointerOver(true);
    const leave = () => void window.companion.pointerOver(false);
    root.addEventListener("pointerenter", enter);
    root.addEventListener("pointerleave", leave);
    return () => {
      root.removeEventListener("pointerenter", enter);
      root.removeEventListener("pointerleave", leave);
    };
  }, []);
}

export function PetLive() {
  const { petState } = useCompanionContext(null);
  const talkKey = useTalkKey();
  // The held key comes from main as down/up; the pill turns it into the same hold as a pointer press.
  const [keyHeld, setKeyHeld] = useState(false);
  useEffect(() => window.companion.talk.onKey(setKeyHeld), []);
  return (
    <Pet
      state={petState}
      talkKey={talkKey}
      keyHeld={keyHeld}
      onOpen={() => void window.companion.openPanel()}
      onMove={(dx, dy) => void window.companion.dragPet(dx, dy)}
      onPress={(phase) => void window.companion.petPress(phase)}
      onHover={(over) => void window.companion.pointerOver(over)}
      onCompose={() => void window.companion.openCapture()}
    />
  );
}

export function PanelLive() {
  const [shown, setShown] = useState<PanelShowing & { at: number }>({ projectId: null, capture: false, at: 0 });
  useEffect(() => window.companion.onPanelShow((showing) => setShown({ ...showing, at: Date.now() })), []);
  usePointerOver();
  const ctx = useCompanionContext(shown.projectId);
  const work = ctx.prepared?.work;
  // Only the app window records a return; opening the panel must not move "since you were last here".
  const today = useToday({ recordReturn: false });
  // Existing subscriptions (shared with Today and Schedule): when the user was last here, today's brief, the next brief.
  const reentryRow = useQuery(api.briefs.getReentry, ctx.cloud.ready ? {} : "skip");
  const morning = useQuery(api.briefs.getPendingBrief, ctx.cloud.ready ? { kind: "morning" } : "skip");
  const schedule = useQuery(api.briefs.getSchedule, ctx.cloud.ready ? {} : "skip");
  const [note, setNote] = useState<string | null>(null);
  const record = useMutation(api.briefs.recordSessionEvent);
  // The evening recap is panel-only: it shows here when the user opens the panel, never as an alert.
  const recap = today.brief?.kind === "evening" ? today.brief : undefined;
  const state: Honest | undefined =
    ctx.cloud.honest ?? (ctx.prepared?.status === "needs-retry" ? { kind: "needs-retry", detail: "The last preparation failed." } : undefined);
  const step = ctx.step ?? work?.nextAction;
  const close = () => void window.companion.closePanel();
  return (
    <Panel
      key={shown.at}
      capture={shown.capture}
      {...(shown.transcript ? { transcript: shown.transcript } : {})}
      petState={ctx.petState}
      now={Date.now()}
      {...(ctx.projectId ? { projectId: ctx.projectId } : {})}
      {...(ctx.name
        ? { leftOff: { project: ctx.name, ...(work?.title ? { artifact: work.title } : {}), ...(step ? { step } : {}), ...(reentryRow?.since ? { at: reentryRow.since } : {}) } }
        : {})}
      {...(morning ? { today: { hard: morning.brief.hard, ...(morning.brief.recommendedAction ? { start: morning.brief.recommendedAction } : {}) } } : {})}
      {...(schedule ? { nextBriefAt: schedule.morningAt } : {})}
      {...(state ? { state } : {})}
      {...(ctx.done ? { completion: { done: ctx.done, ...(work?.nextAction ? { next: work.nextAction } : {}) } } : {})}
      {...(recap ? { recap: { key: recap.key, items: recap.items, delivered: recap.delivered } } : {})}
      onRecapShown={today.onBriefShown}
      {...(today.nudge ? { nudge: today.nudge } : {})}
      onNudge={async (choice) => {
        if (!today.nudge) return;
        const projectId = await today.onNudge(today.nudge.nudgeId, choice);
        if (choice === "finish") void window.companion.openApp(projectId); // the user's click opens the draft
      }}
      {...(ctx.receipt ? { receipt: ctx.receipt } : {})}
      {...(note ? { note } : {})}
      onOpenApp={() => void window.companion.openApp(ctx.projectId ?? undefined)}
      onStop={() => {
        // Stop records a stop and starts nothing; the panel closes either way.
        if (!ctx.cloud.ready) return close(); // signed out: there is no session to record
        record({ kind: "stop" }).then(close, (err: unknown) => setNote(`Stop was not recorded: ${reason(err)}. Nothing was started.`));
      }}
      onClose={close}
    />
  );
}
