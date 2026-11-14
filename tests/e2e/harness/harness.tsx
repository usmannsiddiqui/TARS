// TEST-ONLY harness: mounts the presentational screens with ILLUSTRATIVE props for visual review
// and for behaviour that needs cloud data no test can sign in to yet. Never part of the product
// bundle (it lives under tests/ and is served only by the e2e spec's own Vite server).
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Connections } from "../../../apps/desktop/src/renderer/Connections";
import { Home } from "../../../apps/desktop/src/renderer/Home";
import { MemoryView } from "../../../apps/desktop/src/renderer/MemoryView";
import type { Commitment, Evidence, Fact, PetState, ProjectSummary, SourceRow } from "../../../apps/desktop/src/renderer/model";
import { Panel } from "../../../apps/desktop/src/renderer/Panel";
import { Pet } from "../../../apps/desktop/src/renderer/Pet";
import { ProjectView, type ArtifactView, type EditorActions } from "../../../apps/desktop/src/renderer/ProjectView";
import { recommendStart } from "../../../apps/desktop/src/renderer/recommend";
import { Shell, Stopped, type Route } from "../../../apps/desktop/src/renderer/Shell";
import "../../../apps/desktop/src/renderer/styles.css";

// Every call a screen makes is recorded here for the spec to assert.
const calls: unknown[][] = [];
(window as unknown as { __calls: unknown[][] }).__calls = calls;
const record = (...args: unknown[]) => void calls.push(args);

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
const rows: SourceRow[] = [
  { id: "src-notes", name: "Notes folder: HackUmass vault", coverage: "Markdown notes in one folder you pick: build orders, decisions, logs.", group: "mac", state: "on", cloudProcessing: false, status: { kind: "last-checked", at: inDays(0, 9) } },
  { id: "claude-code", name: "Claude Code sessions", coverage: "Relevant excerpts from Claude Code session files in a folder you pick. Not Claude Desktop projects.", group: "mac", state: "off" },
  { id: "codex", name: "Codex sessions", coverage: "Relevant excerpts from Codex session files in a folder you pick.", group: "mac", state: "off" },
  { id: "src-outlook", name: "Outlook mail", coverage: "The threads or folders you select.", group: "cloud", state: "on", status: { kind: "missing-access", detail: "Sign-in expired. Reconnect to keep reading this thread." } },
  { id: "slack", name: "Slack", coverage: "Selected channels and threads: commitments and who is waiting on whom.", group: "cloud", state: "unavailable", unavailableReason: "Connecting this account from the app is not built yet." },
  { id: "canvas", name: "Canvas", coverage: "Selected courses and their real due dates. Checked when you connect and when you press Refresh.", group: "cloud", state: "on", status: { kind: "stale", at: inDays(-4, 12) } },
  { id: "observation", name: "Selected apps", coverage: "Visible text from apps you choose. No screenshots.", group: "optional", state: "unavailable", unavailableReason: "Not available in this build." },
];

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

function AppScene({ initial }: { initial: Route }) {
  const [route, setRoute] = useState<Route>(initial);
  const [focus, setFocus] = useState("guides");
  const [stopped, setStopped] = useState(false);
  const [pet, setPet] = useState(true);
  const [captured, setCaptured] = useState(ideas);
  const { artifact, editor } = useEditor();
  const pick = (id: string) => {
    if (id === focus) return; // as App.tsx: picking the current focus changes nothing
    record("switchProject", { targetProjectId: id, userInitiated: true });
    setFocus(id);
  };
  if (stopped) return <Stopped projectName="AI Guides" onResume={() => setStopped(false)} />;
  const project = route.view === "project" ? projects.find((p) => p.id === route.projectId) : undefined;
  return (
    <Shell
      route={route}
      projects={projects.map((p) => ({ id: p.id, name: p.name, ...(p.prepared?.status === "needs-retry" ? { note: "Needs retry" } : {}) }))}
      focusProjectId={focus}
      account={{ signedIn: true, busy: false, onSignIn: () => record("signIn") }}
      pet={{ visible: pet, onToggle: () => (record("setPetVisible", !pet), setPet(!pet)) }}
      onNavigate={setRoute}
      onStop={() => (record("stop"), setStopped(true))}
    >
      {route.view === "today" && (
        <Home
          dateLabel={new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(NOW)}
          projects={projects}
          focusProjectId={focus}
          recommendation={recommendStart(projects, focus, NOW.toISOString())}
          signedIn
          ideas={captured}
          onCapture={async (text) => (record("capture", text), setCaptured([{ text }, ...captured]), text)}
          onStart={(id, mode) => (pick(id), setRoute({ view: "project", projectId: id, mode }))}
          onOpenProject={(id) => setRoute({ view: "project", projectId: id })}
          onCreateProject={async (name) => record("createProject", name)}
        />
      )}
      {project && route.view === "project" && (
        <ProjectView
          key={project.id}
          name={project.name}
          isFocus={project.id === focus}
          {...(route.mode ? { mode: route.mode } : {})}
          {...(project.prepared ? { prepared: project.prepared } : {})}
          evidence={evidence}
          commitments={project.commitments}
          artifact={project.id === "guides" ? artifact : null}
          editor={editor}
          onMakeFocus={() => pick(project.id)}
          onPrepare={async () => record("prepare", project.id)}
          onStop={() => setStopped(true)}
        />
      )}
      {route.view === "memory" && (
        <MemoryView
          projects={projects}
          projectId="guides"
          facts={facts}
          withheld={[{ id: "w1", key: "co_presenter_phone", value: "A phone number from an email signature.", evidenceIds: ["e2"] }]}
          evidence={evidence}
          onSelectProject={(id) => record("selectProject", id)}
          onCorrect={async (fact, value) => record("remember", fact.key, value)}
          onForget={async (fact) => record("forget", fact.key)}
          onAllowRelearning={async (key) => record("allowRelearning", key)}
        />
      )}
      {route.view === "connections" && (
        <Connections
          rows={rows}
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

const routes: Record<string, Route> = {
  today: { view: "today" },
  project: { view: "project", projectId: "guides" },
  memory: { view: "memory" },
  connections: { view: "connections" },
};
const guides = projects[0]!.prepared!.work!;
const element = scene.startsWith("pet-") ? (
  <Pet state={scene.slice(4) as PetState} onOpen={() => record("openPanel")} />
) : scene === "panel" ? (
  <Panel petState="idle" projectName="AI Guides" context={guides.title} nextAction={guides.nextAction} onOpenApp={() => record("openApp", "guides")} onStop={() => record("closePanel")} onClose={() => record("closePanel")} />
) : scene === "panel-done" ? (
  <Panel petState="done" projectName="AI Guides" completion={{ done: "Sent the final slide order to the co-presenter.", next: "Time the demo section." }} onOpenApp={() => record("openApp")} onStop={() => record("stop")} onClose={() => record("closePanel")} />
) : (
  <AppScene initial={routes[scene] ?? { view: "today" }} />
);

createRoot(document.getElementById("root")!).render(<StrictMode>{element}</StrictMode>);
