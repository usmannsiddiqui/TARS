// TEST-ONLY harness: mounts the presentational screens with ILLUSTRATIVE props for visual review
// and for behaviour that needs cloud data no test can sign in to yet. Never part of the product
// bundle (it lives under tests/ and is served only by the e2e spec's own Vite server).
import { record } from "./bridge"; // first: the Composer reads the bridge when it loads
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ActingActions } from "../../../apps/desktop/src/renderer/Act";
import { Connections, type CloudActions } from "../../../apps/desktop/src/renderer/Connections";
import { Home } from "../../../apps/desktop/src/renderer/Home";
import { HelperCards, type HelperActions } from "../../../apps/desktop/src/renderer/Helpers";
import { MemoryView } from "../../../apps/desktop/src/renderer/MemoryView";
import type { Brief, Commitment, Evidence, Fact, HelperRun, PetState, ProjectSummary, Receipt, Reentry, SessionState, SourceRow } from "../../../apps/desktop/src/renderer/model";
import { Panel } from "../../../apps/desktop/src/renderer/Panel";
import { Pet } from "../../../apps/desktop/src/renderer/Pet";
import type { BrainDumpProps, DumpLine, DumpView } from "../../../apps/desktop/src/renderer/BrainDump";
import { ProjectView, type ArtifactView, type EditorActions } from "../../../apps/desktop/src/renderer/ProjectView";
import { railProject, Shell, Stopped, type Route } from "../../../apps/desktop/src/renderer/Shell";
import { ProjectsIndex } from "../../../apps/desktop/src/renderer/ProjectsIndex";
import { Schedule } from "../../../apps/desktop/src/renderer/Schedule";
import { TarsCalendar } from "../../../apps/desktop/src/renderer/TarsCalendar";
import { briefSchedule, tarsCalendar } from "../../../apps/desktop/src/renderer/model";
import "../../../apps/desktop/src/renderer/styles.css";
import "../../../apps/desktop/src/renderer/screens.css";

// Every call a screen makes is recorded (bridge.ts) for the spec to assert.

const NOW = new Date();
const inDays = (d: number, h = 17) => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + d, h).toISOString();

// ---- Illustrative data (storyboard anchors; not real records).
const evidence: Evidence[] = [
  { id: "e1", text: "Co-presentation on 20 November: AI tools at Penn State, about 20 staff, hybrid. AI Studio part is roughly 25 minutes.", occurredAt: inDays(-3, 10), sourceUrl: "https://outlook.office.com/mail", freshness: "current" },
  { id: "e2", text: "Slides 9–18 already exist as a first pass; I'll tidy them before we meet.", occurredAt: inDays(-2, 16), sourceUrl: "https://outlook.office.com/mail", freshness: "current" },
  { id: "e3", text: "Build order: demo first, then the choosing-a-tool exercise.", occurredAt: inDays(-1, 21), freshness: "stale" },
];
const guidesCommitments: Commitment[] = [
  { id: "c1", text: "Run through the AI Studio demo for the co-presentation", ownership: "user", state: "open", dueAt: inDays(6, 14), evidenceIds: ["e1"] },
  { id: "c2", text: "Send the final slide order to the co-presenter", ownership: "user", state: "open", evidenceIds: ["e2"] },
  { id: "c3", text: "Book the hybrid room and check the camera", ownership: "other", state: "waiting", evidenceIds: ["e1"] },
  { id: "c4", text: "Someone could collect three example prompts from staff", ownership: "unassigned", state: "open", evidenceIds: ["e1"] },
];
const projects: ProjectSummary[] = [
  {
    id: "guides",
    name: "AI Guides",
    commitments: guidesCommitments,
    prepared: {
      status: "ready",
      updatedAt: inDays(0, 8),
      work: {
        title: "Presenter run-through for the co-presentation",
        body: "A 25-minute AI Studio segment for about 20 staff, hybrid. Open with the live demo, then the choosing-a-tool exercise. Slides 9–18 exist as a first pass; their content has not been read.",
        evidenceIds: ["e1", "e2", "e3"],
        gaps: ["The content of slides 9–18 (the deck has not been shared)", "Who runs the room camera"],
        nextAction: "Open slides 9–18 and time the demo section against 25 minutes.",
        state: "ready",
      },
    },
  },
  {
    id: "avt",
    name: "AVT",
    commitments: [{ id: "a1", text: "Confirm the equipment list with the venue", ownership: "user", state: "open", evidenceIds: [] }],
    prepared: { status: "ready", updatedAt: inDays(-1, 18), work: { title: "Equipment checklist for Saturday", body: "…", evidenceIds: [], gaps: ["Venue power layout"], nextAction: "Confirm the list with the venue.", state: "partial" } },
  },
  { id: "personal", name: "Personal projects", commitments: [] },
  {
    id: "course",
    name: "Coursework",
    commitments: [{ id: "k1", text: "Reading response 4", ownership: "user", state: "open", dueAt: inDays(5), evidenceIds: [] }],
    prepared: { status: "needs-retry", updatedAt: inDays(-1, 9), lastError: "model_failed" },
  },
];
const ideas = [{ text: "Personal project: a one-page budget tracker for the band" }, { text: "Ask the venue about a quiet room for prep" }];
const facts: Fact[] = [
  { id: "f1", key: "presentation_length", value: "The AI Studio segment is about 25 minutes.", scope: "project", evidenceIds: ["e1"] },
  { id: "f2", key: "audience", value: "Around 20 staff, some joining remotely.", scope: "project", evidenceIds: ["e1"] },
  { id: "f3", key: "draft_style", value: "Keep drafts short, plain and in my voice.", scope: "global", evidenceIds: [] },
];
const localRows: SourceRow[] = [
  { id: "src-notes", name: "Notes folder: HackUmass vault", coverage: "Markdown notes in one folder you pick: build orders, decisions, logs.", group: "mac", state: "on", cloudProcessing: false, status: { kind: "last-checked", at: inDays(0, 9) } },
  { id: "claude-code", name: "Claude Code sessions", coverage: "Relevant excerpts from Claude Code session files in a folder you pick. Not Claude Desktop projects.", group: "mac", state: "off" },
  { id: "codex", name: "Codex sessions", coverage: "Relevant excerpts from Codex session files in a folder you pick.", group: "mac", state: "off" },
];
const cloudOff: SourceRow[] = [
  { id: "slack", provider: "slack", name: "Slack", coverage: "Selected channels and threads: commitments and who is waiting on whom.", group: "cloud", state: "off" },
  { id: "gmail", provider: "gmail", name: "Gmail", coverage: "Selected project labels and threads.", group: "cloud", state: "off" },
  { id: "notion", provider: "notion", name: "Notion", coverage: "Pages you share with the app, and the outcome log you choose.", group: "cloud", state: "off" },
  { id: "canvas", provider: "canvas", name: "Canvas", coverage: "Your Canvas calendar: assignment due dates and course events. Checked when you connect and when you press Refresh.", group: "cloud", state: "off" },
  { id: "outlook-mail", provider: "outlook-mail", name: "Outlook mail", coverage: "The threads or folders you select.", group: "cloud", state: "off" },
  { id: "outlook-calendar", provider: "outlook-calendar", name: "Outlook calendar", coverage: "Selected calendars, so preparation never lands in a meeting.", group: "cloud", state: "off" },
];
const observation: SourceRow = { id: "observation", name: "Selected apps", coverage: "Visible text from apps and sites you name. No screenshots, no keystrokes.", group: "optional", state: "off" };
// "connections": two cloud accounts already connected, the rest off. "connections-fresh": every source off.
const freshLocal: SourceRow[] = [{ id: "obsidian", name: "Notes folder", coverage: localRows[0]!.coverage, group: "mac", state: "off" }, localRows[1]!, localRows[2]!];
const connectedRows = (fresh: boolean): SourceRow[] => [
  ...(fresh ? freshLocal : localRows),
  ...cloudOff.map((r): SourceRow =>
    fresh
      ? r
      : r.provider === "notion"
        ? { ...r, id: "notion-illustrative", state: "on", status: { kind: "last-checked", at: inDays(0, 8) }, selection: { selectors: ["8f2c…a41 (AI Guides plan)"], projects: ["AI Guides"] } }
        : r.provider === "canvas"
          ? { ...r, id: "canvas-illustrative", state: "on", status: { kind: "stale", at: inDays(-4, 12) }, selection: { selectors: ["COURSE 1182"], projects: ["Coursework"] } }
          : r.provider === "slack"
            ? { ...r, id: "slack-illustrative", state: "paused", status: { kind: "last-checked", at: inDays(-1, 17) }, selection: { selectors: ["C0123", "C0456"], projects: ["AVT"] } }
            : r,
  ),
  fresh
    ? observation
    : { id: "obs-illustrative", name: "Selected apps: Notes", coverage: "Visible text from com.apple.Notes while it is in front.", group: "optional", state: "on", cloudProcessing: false, permissionMissing: true },
];

// ---- Illustrative brief, re-entry and receipts (shapes of briefs.* and actions.*; not real records).
const morning: Brief = {
  key: "morning:2026-11-14",
  kind: "morning",
  preparedAt: Date.parse(inDays(0, 9)),
  delivered: false,
  items: [],
  hard: [
    { commitmentId: "m1", projectId: "avt", text: "Venue walk-through with the AV lead", dueAt: inDays(0, 15), kind: "meeting", sourceKind: "outlook-calendar", lastCheckedAt: inDays(0, 8), current: true },
    { commitmentId: "k1", projectId: "course", text: "Reading response 4", dueAt: inDays(5), kind: "deadline", sourceKind: "canvas", lastCheckedAt: inDays(-4, 12), current: false },
    { commitmentId: "c1", projectId: "guides", text: "Run through the AI Studio demo for the co-presentation", dueAt: inDays(6, 14), kind: "deadline", sourceKind: "outlook-mail", lastCheckedAt: inDays(0, 8), current: true },
  ],
  suggested: [
    { projectId: "guides", text: "Open slides 9–18 and time the demo section against 25 minutes." },
    { projectId: "guides", text: "Send the final slide order to the co-presenter", commitmentId: "c2" },
    { projectId: "avt", text: "Confirm the equipment list with the venue", commitmentId: "a1" },
  ],
  triage: [],
  recommendedAction: "Open slides 9–18 and time the demo section against 25 minutes.",
  reason: "You chose this last time; nothing due sooner is backed by your sources.",
  stale: [{ name: "Canvas", lastCheckedAt: inDays(-4, 12) }],
  read: [
    { kind: "outlook-calendar", count: 1 },
    { kind: "outlook-mail", count: 4 },
    { kind: "canvas", count: 1 },
    { kind: "commitments", count: 6 },
  ],
};
// Morning brief states (today-<variant>): each a real state of the stored brief, the schedule and the brief service.
const briefStates: Record<string, Brief | null | undefined> = {
  loading: undefined,
  waiting: null,
  failed: morning,
  // A brief prepared before "what I read" was stored: no rows, nothing invented.
  older: Object.fromEntries(Object.entries(morning).filter(([key]) => key !== "read")) as Brief,
  nothing: { ...morning, hard: [], suggested: [], recommendedAction: undefined, reason: undefined, read: [] } as Brief,
  long: {
    ...morning,
    hard: [
      ...morning.hard,
      { commitmentId: "k2", projectId: "course", text: "Group project milestone 2: submit the revised architecture diagram, the risk register and the peer-evaluation form for all four members", dueAt: inDays(1, 23), kind: "deadline", sourceKind: "canvas", current: true },
    ],
    recommendedAction: "Group project milestone 2: submit the revised architecture diagram, the risk register and the peer-evaluation form for all four members",
    reason: "Due tomorrow at 11:00 PM, the earliest of three deadlines backed by your sources.",
    read: [
      { kind: "outlook-calendar", count: 3 },
      { kind: "gmail", count: 27 },
      { kind: "outlook-mail", count: 1 },
      { kind: "canvas", count: 2 },
      { kind: "slack", count: 14 },
      { kind: "notion", count: 1 },
      { kind: "obsidian", count: 5 },
      { kind: "commitments", count: 11 },
    ],
  },
};
const briefFailure = "Could not reach the brief service. TARS tries again when you come back to this window.";
const evening: Brief = {
  key: "evening:2026-11-14",
  kind: "evening",
  preparedAt: Date.parse(inDays(0, 19)),
  delivered: false,
  items: ["Done (verified): Send the final slide order to the co-presenter", "Done (you reported): Confirm the equipment list with the venue", "Parked: Run through the AI Studio demo for the co-presentation", "Parked: Reading response 4"],
  hard: [],
  suggested: [],
  triage: [],
  stale: [],
};
const reentry: Reentry = {
  since: inDays(-5, 18),
  changed: [
    { evidenceId: "e2", text: "Slides 9–18 already exist as a first pass; I'll tidy them before we meet.", occurredAt: inDays(-2, 16) },
    { evidenceId: "e4", text: "Canvas: Reading response 4 due date confirmed.", occurredAt: inDays(-3, 11) },
  ],
  changedCount: 7,
  urgent: [{ commitmentId: "m1", projectId: "avt", text: "Venue walk-through with the AV lead", dueAt: inDays(0, 15), kind: "meeting", sourceKind: "outlook-calendar", lastCheckedAt: inDays(0, 8), current: true }],
  recommendedAction: "Venue walk-through with the AV lead",
  reason: "Due today at 15:00.",
};
const tradeoff = { commitmentId: "c9", text: '"Launch the AVT landing page this week" is due within a day of "Venue walk-through with the AV lead". Choose what goes first; nothing will be moved or sent.' };

function useEditor(): { artifact: ArtifactView; editor: EditorActions } {
  const [artifact, setArtifact] = useState<ArtifactView>({
    id: "art1",
    revision: "3",
    userEdited: true,
    text: "1. Welcome and why tools differ (2 min)\n2. Live demo: AI Studio on a real staff task (10 min)\n3. Choosing a tool: three questions to ask (8 min)\n4. Questions (5 min)",
    suggestions: [{ id: "s1", kind: "source", changeSummary: "The co-presenter moved the demo after the exercise.", baseRevision: "3" }],
  });
  const step = (text: string, summary: string) => {
    const previous = artifact.revision;
    const revision = String(Number(previous) + 1);
    setArtifact({ ...artifact, revision, text });
    return { status: "applied" as const, changeSummary: summary, undoRevision: previous, revision };
  };
  return {
    artifact,
    editor: {
      create: async () => record("create"),
      save: async (text, base) => (record("save", base), step(text, "Saved your edits.")),
      revise: async (instruction, base) => (record("revise", instruction, base), step(artifact.text.replace("(10 min)", "(7 min)"), "Shortened the live demo to 7 minutes.")),
      undo: async (expected, undoRevision) => (record("undo", expected, undoRevision), step(artifact.text.replace("(7 min)", "(10 min)"), `Restored revision ${undoRevision}.`)),
      applySuggestion: async (id, base) => (record("applySuggestion", id, base), setArtifact({ ...artifact, suggestions: [] }), { status: "applied" as const, changeSummary: "Moved the demo after the exercise.", revision: artifact.revision }),
      dismissSuggestion: async (id) => (record("dismissSuggestion", id), setArtifact({ ...artifact, suggestions: [] })),
    },
  };
}

function useActing(variant: string): { receipt: Receipt | null; acting: ActingActions } {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  return {
    receipt,
    acting: {
      execute: async (intent, saved) => {
        record("executeIntent", { kind: intent.kind, destination: intent.destination, revision: saved.revision, ...(intent.taskId ? { taskId: intent.taskId } : {}) });
        const next: Receipt =
          variant === "unknown"
            ? { id: "act-1", kind: intent.kind, destination: intent.destination, revision: saved.revision, state: "unknown", logState: "not-due", reason: "timeout" }
            : { id: "act-1", kind: intent.kind, destination: intent.destination, revision: saved.revision, state: "succeeded", verifiedAt: new Date().toISOString(), externalId: "illustrative-message-1", logState: "failed" };
        setReceipt(next);
        return { status: "receipt", receipt: next };
      },
      // Illustrative: the provider still cannot say, so the receipt stays unknown.
      reconcile: async (id) => record("reconcileAction", id),
      retryLog: async (id) => (record("appendOutcomeLog", id), setReceipt((r) => r && { ...r, logState: "written" })),
      setLogDestination: async (kind, target) => record("setLogDestination", kind, target),
      notes: { sources: [{ id: "src-notes", name: "HackUmass vault", cloudProcessing: true }], designate: async (id) => (record("designateLogNote", id), { target: "note-illustrative", name: "AI Guides log.md" }) },
      sendConsent: { blocked: "This build cannot open your browser for the provider's sign-in page yet. Nothing was sent." },
    },
  };
}

const cloudActions: CloudActions = {
  onConnect: async (provider, form) => record("connect", provider, { projectId: form.projectId, selectors: form.selectors, writeTargets: form.writeTargets }),
  onRefresh: async (row) => record("refresh", row.id),
  onPause: async (row) => record("pauseCloud", row.id),
  onResume: async (row) => record("resumeCloud", row.id),
  onRevoke: async (row) => record("revokeCloud", row.id),
  notionWebhookUrl: (id) => `https://illustrative-deployment.convex.site/notion/events?source=${id}`,
  revealNotionToken: async (id) => (record("revealNotionToken", id), "secret_illustrative_verification_token"),
};

// ---- TARS's helpers: every state a run row can be in (illustrative projects and counts).
const run = (projectName: string, over: Partial<HelperRun>): HelperRun => ({ projectId: projectName, projectName, state: "running", sources: [], ...over });
const helperStates: Record<string, HelperRun[]> = {
  starting: [run("AI Guides", { state: "pending" })],
  reading: [run("AI Guides", { stage: "reading" })],
  "one-source": [run("AI Guides", { stage: "drafting", sources: [{ kind: "gmail", count: 3 }] })],
  "several-sources": [run("AI Guides", { stage: "drafting", sources: [{ kind: "gmail", count: 4 }, { kind: "slack", count: 2 }, { kind: "notion", count: 1 }] })],
  saving: [run("AI Guides", { stage: "saving", sources: [{ kind: "gmail", count: 4 }, { kind: "slack", count: 2 }] })],
  failed: [run("AI Guides", { state: "failed" })],
  "two-projects": [
    run("AI Guides", { stage: "drafting", sources: [{ kind: "outlook-mail", count: 5 }, { kind: "obsidian", count: 2 }] }),
    run("AVT", { stage: "reading" }),
  ],
  "long-name": [run("AVT pitch for the regional accelerator, second round, with the revised budget appendix", { stage: "drafting", sources: [{ kind: "canvas", count: 12 }, { kind: "teams", count: 1 }] })],
};
// The real sequence with realistic timings: start, read, draft (the model call), save, then the card leaves.
const helperPlay: [ms: number, runs: HelperRun[]][] = [
  [0, []],
  [600, helperStates["starting"]!],
  [900, helperStates["reading"]!],
  [1700, helperStates["several-sources"]!],
  [7700, helperStates["saving"]!],
  [8400, []],
];
const helperActions: HelperActions = {
  onRetry: async (id) => record("prepareProject", id),
  onDismiss: async (id) => record("dismissFailedRun", id),
};
function usePlayed(on: boolean) {
  const [runs, setRuns] = useState<HelperRun[]>(on ? [] : helperStates["two-projects"]!);
  useEffect(() => {
    if (!on) return;
    const timers = helperPlay.map(([ms, next]) => setTimeout(() => setRuns(next), ms));
    return () => timers.forEach(clearTimeout);
  }, [on]);
  return runs;
}

// ---- Brain dump: an illustrative sorted capture across three projects, all four kinds, no project, one long line.
const dumpLines: DumpLine[] = [
  { id: "d1", text: "Finish the thermo lab report", projectId: "course", kind: "todo", dueAt: new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + 5, 23, 59).toISOString() },
  { id: "d2", text: "Sam still owes me the wiring diagram", projectId: "avt", kind: "waiting" },
  {
    id: "d3",
    text: "Order the second battery pack, the 48-volt one from the supplier Priya mentioned, but only after the budget meeting confirms we can spend it before the end of the semester",
    projectId: "avt",
    kind: "todo",
  },
  { id: "d4", text: "Sponsor deck can wait until December", projectId: "avt", kind: "parked" },
  { id: "d5", text: "A short video on choosing a tool", projectId: "guides", kind: "idea" },
  { id: "d6", text: "Email everyone the deck", projectId: "guides", kind: "todo" },
  { id: "d7", text: "Look into a standing desk for the lab", projectId: null, kind: "idea" },
];
const dumpViews: Record<string, DumpView> = {
  sorting: { kind: "sorting", projects: projects.length },
  sorted: { kind: "sorted", lines: dumpLines },
  sortfailed: { kind: "failed", detail: "the sorting model did not answer (timeout)." },
};
/** As the live hook would: Save starts a sort, and a few seconds later the lines arrive; Fix changes them in place. */
function useHarnessDump(variant: string): BrainDumpProps | undefined {
  const [view, setView] = useState<DumpView | undefined>(dumpViews[variant]);
  if (!(variant in dumpViews) && variant !== "dump") return undefined;
  const lines = view?.kind === "sorted" ? view.lines : [];
  const change = (id: string, patch: Partial<DumpLine> | null) =>
    setView({ kind: "sorted", lines: patch === null ? lines.filter((l) => l.id !== id) : lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  return {
    cloud: true,
    projects: projects.map(({ id, name }) => ({ id, name })),
    ...(view ? { view } : {}),
    onSaved: (id) => {
      record("sortCapture", id);
      setView({ kind: "sorting", projects: projects.length });
      setTimeout(() => setView({ kind: "sorted", lines: dumpLines }), 2400);
    },
    onRetry: () => (record("sortCapture", "retry"), setView({ kind: "sorting", projects: projects.length })),
    onMove: async (id, projectId) => (record("moveItem", id, projectId), change(id, { projectId })),
    onSetKind: async (id, kind) => (record("setItemKind", id, kind), change(id, { kind })),
    onRemove: async (id) => (record("removeItem", id), change(id, null)),
  };
}

/** The panel opened for capture, with the brain dump in its capture box. */
function PanelDump({ variant }: { variant: string }) {
  const brainDump = useHarnessDump(variant);
  return (
    <Panel
      petState="idle"
      helpers={[]}
      helperActions={helperActions}
      now={NOW.getTime()}
      leftOff={{ project: "AI Guides", artifact: projects[0]!.prepared!.work!.title }}
      capture
      {...(brainDump ? { brainDump } : {})}
      onRecapShown={(key) => record("markDelivered", key, "panel")}
      onOpenApp={() => record("openApp", "guides")}
      onStop={() => record("closePanel")}
      onClose={() => record("closePanel")}
    />
  );
}

function HelperGrid({ only }: { only?: string | undefined }) {
  const names = only ? [only] : Object.keys(helperStates);
  return (
    <main className="helper-harness">
      {/* Harness chrome only: plain grey labels, a scrolling page, a fixed card width per cell. */}
      <style>{`.helper-harness{height:100%;overflow:auto;padding:24px clamp(16px,3vw,32px);display:grid;grid-template-columns:repeat(auto-fill,minmax(min(340px,100%),1fr));gap:20px 24px;align-content:start}
.helper-harness figure{margin:0}.helper-harness figcaption{font:12px var(--mono);color:var(--ink-3);margin-bottom:6px}`}</style>
      {names.map((name) => (
        <figure key={name}>
          {!only && <figcaption>{name}</figcaption>}
          <HelperCards runs={helperStates[name] ?? []} actions={helperActions} />
        </figure>
      ))}
    </main>
  );
}

function AppScene({ initial, variant }: { initial: Route; variant: string }) {
  const played = usePlayed(variant === "play");
  const brainDump = useHarnessDump(variant);
  const [route, setRoute] = useState<Route>(initial);
  const [session, setSession] = useState<SessionState>("idle");
  // As the subscription would: a brief reported as shown comes back delivered.
  const [delivered, setDelivered] = useState<string[]>([]);
  const { receipt, acting } = useActing(variant);
  const [focus, setFocus] = useState("guides");
  const [stopped, setStopped] = useState(false);
  const [pet, setPet] = useState(true);
  const { artifact, editor } = useEditor();
  const pick = (id: string) => {
    if (id === focus) return; // as App.tsx: picking the current focus changes nothing
    record("switchProject", { targetProjectId: id, userInitiated: true });
    setFocus(id);
  };
  function stop() {
    record("session", "stop");
    setSession("idle");
    setStopped(true);
  }
  if (stopped) return <Stopped projectName="AI Guides" onResume={() => setStopped(false)} />;
  const project = route.view === "project" ? projects.find((p) => p.id === route.projectId) : undefined;
  return (
    <Shell
      route={route}
      projects={projects.map(railProject)}
      focusProjectId={focus}
      account={{ signedIn: true, busy: false, onSignIn: () => record("signIn") }}
      pet={{ visible: pet, onToggle: () => (record("setPetVisible", !pet), setPet(!pet)) }}
      session={{ state: session, onEvent: (e) => (record("session", e), setSession({ start: "working", resume: "working", break: "break" }[e] as SessionState)) }}
      onNavigate={setRoute}
      onStop={stop}
    >
      {route.view === "today" && (
        <Home
          dateLabel={new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(NOW)}
          projects={projects}
          helpers={variant === "helpers" || variant === "play" ? played : []}
          helperActions={helperActions}
          focusProjectId={focus}
          brief={((b) => b && { ...b, delivered: delivered.includes(b.key) })(variant in briefStates ? briefStates[variant] : variant === "evening" ? evening : morning)}
          {...(variant === "failed" ? { briefError: briefFailure } : {})}
          schedule={briefSchedule(Date.parse(inDays(1, 9)), Intl.DateTimeFormat().resolvedOptions().timeZone, NOW.getTime())}
          {...(variant === "reentry" ? { reentry } : {})}
          {...(variant === "" ? { tradeoff } : {})}
          onBriefShown={(key) => (record("markDelivered", key, "panel"), setDelivered((d) => [...d, key]))}
          onResolveTradeoff={async (id, choice) => record("resolveTradeoff", id, choice)}
          ideas={ideas}
          {...(brainDump ? { brainDump } : {})}
          sessionWorking={session === "working"}
          onCaptured={() => undefined}
          onStart={(id, mode) => (pick(id), session === "idle" && (record("session", "start"), setSession("working")), setRoute({ view: "project", projectId: id, mode }))}
          onOpenProject={(id) => setRoute({ view: "project", projectId: id })}
          onCreateProject={async (name) => record("createProject", name)}
        />
      )}
      {project && route.view === "project" && (
        <ProjectView
          key={project.id}
          name={project.name}
          logDestination={variant === "unknown" ? null : { kind: "notion", label: "8f2c…a41" }}
          isFocus={project.id === focus}
          {...(route.mode ? { mode: route.mode } : {})}
          {...(project.prepared ? { prepared: project.prepared } : {})}
          evidence={evidence}
          commitments={project.commitments}
          artifact={project.id === "guides" ? artifact : null}
          editor={editor}
          receipt={receipt}
          acting={acting}
          sharing={{ state: null, share: async (r) => record("share", r), update: async (r) => record("updateShare", r), stop: async () => record("stopSharing") }}
          onReportDone={async (taskId) => record("reportDone", taskId)}
          onMakeFocus={() => pick(project.id)}
          onPrepare={async () => record("prepare", project.id)}
          onStop={stop}
        />
      )}
      {route.view === "projects" && (
        <ProjectsIndex projects={variant === "empty" ? [] : projects} focusProjectId={focus} onOpenProject={(id) => setRoute({ view: "project", projectId: id })} onCreateProject={async (name) => record("createProject", name)} />
      )}
      {route.view === "schedule" && (
        <Schedule brief={variant === "empty" ? null : morning} nextBriefAt={Date.parse(inDays(1, 9))} now={NOW.getTime()} nameOf={(id) => projects.find((p) => p.id === id)?.name} />
      )}
      {route.view === "calendar" && (
        <TarsCalendar
          now={NOW.getTime()}
          calendar={tarsCalendar(
            variant === "empty"
              ? { now: NOW.getTime(), schedule: null, briefs: [], projects: [], sources: [] }
              : {
                  now: NOW.getTime(),
                  schedule: { morningAt: Date.parse(inDays(1, 9)), eveningAt: Date.parse(inDays(0, 19)) + (NOW.getHours() >= 19 ? 864e5 : 0) },
                  briefs: [{ kind: "morning", preparedAt: Math.min(morning.preparedAt, NOW.getTime()), delivered: true }],
                  projects,
                  sources: [
                    { name: "Notion", availability: "connected", lastCheckedAt: inDays(0, Math.min(8, NOW.getHours())) },
                    { name: "Canvas", availability: "stale", lastCheckedAt: inDays(-4, 12) },
                  ],
                },
          )}
        />
      )}
      {route.view === "memory" && (
        <MemoryView
          projects={projects}
          projectId="guides"
          {...(variant === "loading" ? { state: { kind: "loading", detail: "Reading what I remember…" } as const } : {})}
          facts={variant === "empty" ? [] : facts}
          withheld={variant === "empty" ? [] : [{ id: "w1", key: "co_presenter_phone", value: "A phone number from an email signature.", evidenceIds: ["e2"] }]}
          evidence={evidence}
          onSelectProject={(id) => record("selectProject", id)}
          onCorrect={async (fact, value) => record("remember", fact.key, value)}
          onForget={async (fact) => record("forget", fact.key)}
          onAllowRelearning={async (fact) => record("allowRelearning", fact.key)}
          onAccept={async (item) => record("acceptWithheld", item.id)}
          onDismiss={async (item) => record("dismissWithheld", item.id)}
        />
      )}
      {route.view === "connections" && (
        <Connections
          rows={connectedRows(variant === "fresh")}
          cloud={cloudActions}
          observation={{
            onStart: async (selectors, projectId) => record("observation.start", selectors, projectId),
            onDeleteRetained: async (id) => record("observation.deleteRetained", id),
            onOpenAccessibility: async () => record("observation.openAccessibilitySettings"),
          }}
          shortcut={{ status: { accelerator: "CommandOrControl+Shift+Space", registered: false, error: "another app already uses it" }, onSet: async (a) => record("shortcut.set", a) }}
          talkKey={{ status: { key: "Right Option (⌥)", state: "permission-missing" }, onOpenAccessibility: async () => record("talk.openAccessibilitySettings") }}
          selfText={{ setting: { enabled: false, handle: "" }, onSave: async (s) => record("selfText.set", s), onTest: async () => (record("selfText.test"), "sent" as const) }}
          projects={projects}
          onAdd={async (kind, projectId) => record("chooseSource", kind, projectId)}
          onPause={async (id) => record("pause", id)}
          onResume={async (id) => record("resume", id)}
          onRevoke={async (id) => record("revoke", id)}
          onSetCloud={async (id, enabled) => record("setCloud", id, enabled)}
        />
      )}
    </Shell>
  );
}

const scene = location.hash.slice(1) || "today";
document.documentElement.dataset["view"] = scene.startsWith("pet") ? "pet" : scene.startsWith("panel") ? "panel" : "app";

// Scene names: "<route>" or "<route>-<variant>", e.g. today-reentry, project-unknown, connections-fresh.
const routes: Record<string, Route> = {
  today: { view: "today" },
  project: { view: "project", projectId: "guides" },
  // project-<id>: another illustrative project (avt: partial; personal: nothing prepared; course: needs retry).
  memory: { view: "memory" },
  connections: { view: "connections" },
  projects: { view: "projects" },
  schedule: { view: "schedule" },
  calendar: { view: "calendar" },
};
const [routeName = "today", variant = ""] = scene.split("-");
const projectVariant = routeName === "project" && projects.some((p) => p.id === variant) ? variant : undefined;
const guides = projects[0]!.prepared!.work!;
// Today's meetings and due dates for the panel: one already past (midnight), one still ahead (late evening), one next week.
const panelToday = [
  { ...morning.hard[0]!, text: "Stand-up with the AV lead", dueAt: new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 0, 0).toISOString() },
  { ...morning.hard[0]!, text: "Rehearsal call with the co-presenter", dueAt: new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 23, 59).toISOString() },
  morning.hard[2]!,
];
// pet-<state>, or pet-<state>-recording (the voice button gets a silent generated stream, see bridge.ts).
const element = scene.startsWith("pet-") ? (
  <Pet
    state={scene.split("-")[1] as PetState}
    talkKey={{ key: "Right Option (⌥)", state: "ready" }}
    keyHeld={false}
    onOpen={() => record("openPanel")}
    onMove={(dx, dy) => record("dragPet", dx, dy)}
    onPress={(phase) => record("petPress", phase)}
    onHover={(over) => record("hover", over)}
    onCompose={() => record("compose")}
  />
) : scene === "helpers" || scene.startsWith("helpers-") ? (
  <HelperGrid only={scene.slice("helpers-".length) || undefined} />
) : scene === "panel-helpers" ? (
  <Panel
    petState="working"
    helpers={helperStates["two-projects"]!}
    helperActions={helperActions}
    now={NOW.getTime()}
    leftOff={{ project: "AI Guides", artifact: guides.title, step: guides.nextAction, at: inDays(-1, 18) }}
    today={{ hard: panelToday, start: "Send the final slide order to the co-presenter" }}
    onRecapShown={(key) => record("markDelivered", key, "panel")}
    onOpenApp={() => record("openApp", "guides")}
    onStop={() => record("closePanel")}
    onClose={() => record("closePanel")}
  />
) : ["panel-sorting", "panel-sorted", "panel-sortfailed", "panel-dump"].includes(scene) ? (
  <PanelDump variant={scene.slice("panel-".length)} />
) : scene === "panel-transcript" ? (
  <Panel
    petState="idle"
    helpers={[]}
    helperActions={helperActions}
    now={NOW.getTime()}
    leftOff={{ project: "AI Guides", artifact: guides.title }}
    capture
    transcript={{ text: "Ask the AV lead for a second wireless mic", recoveryId: "rec_illustrative" }}
    onRecapShown={(key) => record("markDelivered", key, "panel")}
    onOpenApp={() => record("openApp", "guides")}
    onStop={() => record("closePanel")}
    onClose={() => record("closePanel")}
  />
) : scene === "panel" ? (
  <Panel
    petState="idle"
    helpers={[]}
    helperActions={helperActions}
    now={NOW.getTime()}
    leftOff={{ project: "AI Guides", artifact: guides.title, step: guides.nextAction, at: inDays(-1, 18) }}
    today={{ hard: panelToday, start: "Send the final slide order to the co-presenter" }}
    onRecapShown={(key) => record("markDelivered", key, "panel")}
    onOpenApp={() => record("openApp", "guides")}
    onStop={() => record("closePanel")}
    onClose={() => record("closePanel")}
  />
) : scene === "panel-empty" ? (
  <Panel petState="idle" helpers={[]} helperActions={helperActions} now={NOW.getTime()} nextBriefAt={new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + 1, 9).getTime()} onRecapShown={(key) => record("markDelivered", key, "panel")} onOpenApp={() => record("openApp")} onStop={() => record("closePanel")} onClose={() => record("closePanel")} />
) : scene === "panel-evening" ? (
  <Panel
    petState="idle"
    helpers={[]}
    helperActions={helperActions}
    now={NOW.getTime()}
    leftOff={{ project: "AI Guides", artifact: guides.title }}
    recap={{ key: evening.key, items: evening.items, delivered: false }}
    onRecapShown={(key) => record("markDelivered", key, "panel")}
    onOpenApp={() => record("openApp", "guides")}
    onStop={() => record("session", "stop")}
    onClose={() => record("closePanel")}
  />
) : scene === "panel-done" ? (
  <Panel petState="done" helpers={[]} helperActions={helperActions} now={NOW.getTime()} completion={{ done: "Sent the final slide order to the co-presenter.", next: "Time the demo section." }} onRecapShown={(key) => record("markDelivered", key, "panel")} onOpenApp={() => record("openApp")} onStop={() => record("stop")} onClose={() => record("closePanel")} />
) : (
  <AppScene initial={projectVariant ? { view: "project", projectId: projectVariant } : (routes[routeName] ?? { view: "today" })} variant={variant} />
);

createRoot(document.getElementById("root")!).render(<StrictMode>{element}</StrictMode>);
