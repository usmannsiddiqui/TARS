// The full app window: routes between Today, a project, and under More the schedule, TARS's calendar,
// connections and memory. Focus changes
// only when the user picks a project here (switchProject with userInitiated: true).
import { useAction, useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { CaptureInput } from "@companion/domain";
import { api } from "../../../../convex/_generated/api";
import { DeskPane } from "./Desk";
import { Home } from "./Home";
import { Boundary } from "./boundary";
import { CalendarLive, ConnectionsLive, MemoryLive, ProjectLive, ScheduleLive, useBrainDump, useCloud, useHelpers, useProjectSummaries, useSession, useToday } from "./live";
import { rowPreview, todayPreview, type PetState } from "./model";
import { RetryNote, scrollWithin } from "./ui";
import { Shell, Stopped, type Route } from "./Shell";

const dateLabel = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Mounted only by the user's "Stop for now": today's recap. The backend sends it to his linked Telegram on the stop event. */
function StoppedLive({ ready, ...props }: { ready: boolean; projectName?: string; note?: string; onResume(): void }) {
  const recap = useQuery(api.recap.getClosingRecap, ready ? { timezone } : "skip");
  return <Stopped {...props} {...(recap ? { recap } : {})} />;
}

/** Today's subscriptions in their own component, so one that throws is caught by its boundary, not the window. */
type TodayLive = { today: ReturnType<typeof useToday>; helpers: ReturnType<typeof useHelpers>; brainDump: ReturnType<typeof useBrainDump> };
function TodayData({ children }: { children(live: TodayLive): ReactNode }) {
  const today = useToday({ recordReturn: true });
  const helpers = useHelpers();
  const brainDump = useBrainDump();
  return children({ today, helpers, brainDump });
}

/** The window's own subscriptions (projects, focus) failing still leaves an honest screen with Try again. */
export function App() {
  return (
    <Boundary
      name="your projects"
      fallback={(retry) => (
        <main className="stopped">
          <RetryNote what="Your projects" onRetry={retry} />
        </main>
      )}
    >
      <AppWindow />
    </Boundary>
  );
}

function AppWindow() {
  const cloud = useCloud();
  const [route, setRoute] = useState<Route>({ view: "today" });
  const [stopped, setStopped] = useState(false);
  const [petVisible, setPetVisible] = useState(true);
  // The persisted hide-pet choice, read once from the main process.
  useEffect(() => {
    window.companion.petVisible().then(setPetVisible, () => undefined);
  }, []);
  const [ideas, setIdeas] = useState<CaptureInput[]>([]);

  const projects = useQuery(api.projects.listProjects, cloud.ready ? {} : "skip");
  const focus = useQuery(api.projects.getFocus, cloud.ready ? {} : "skip");
  const summaries = useProjectSummaries(projects);
  const switchProject = useMutation(api.projects.switchProject);
  const createProject = useMutation(api.projects.createProject);
  const session = useSession();
  const stop = () => {
    session.onEvent("stop");
    setStopped(true);
  };

  // Focus or becoming visible is the event to look for new mail (the backend debounces it); never a timer.
  const checkMail = useAction(api.connectors.composio.checkMail);
  useEffect(() => {
    if (!cloud.ready) return;
    const check = () => {
      if (document.visibilityState === "visible") checkMail({}).catch(() => undefined); // a failure shows on the connector card
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [cloud.ready, checkMail]);

  const loadIdeas = useCallback(() => window.companion.loadPending().then(setIdeas), []);
  useEffect(() => {
    if (cloud.signedIn) void loadIdeas();
  }, [cloud.signedIn, loadIdeas]);

  // "Open app" from the panel: the main process says which project to show.
  useEffect(
    () =>
      window.companion.onNavigate((projectId) => {
        setStopped(false);
        setRoute(projectId ? { view: "project", projectId } : { view: "today" });
      }),
    [],
  );

  const focusId = focus?.projectId;
  const pick = (projectId: string) => {
    if (projectId !== focusId) void switchProject({ targetProjectId: projectId, userInitiated: true });
  };
  const nameOf = (id?: string) => projects?.find((p) => p.id === id)?.name;
  const create = async (name: string) => void (await createProject({ name }));
  const open = (projectId: string) => setRoute({ view: "project", projectId });

  if (stopped) return <StoppedLive ready={cloud.ready} {...(nameOf(focusId) ? { projectName: nameOf(focusId)! } : {})} {...(session.error ? { note: session.error } : {})} onResume={() => setStopped(false)} />;

  return (
    <Boundary name="Today" fallback={(retry) => frame(null, retry)}>
      <TodayData>{(live) => frame(live)}</TodayData>
    </Boundary>
  );

  /** The window, with Today's data, or without it (null) while Today could not load: the rest keeps working. */
  function frame(live: TodayLive | null, retryToday?: () => void) {
  const today = live?.today;
  const helpers = live?.helpers.helpers ?? [];
  // The desk draws only what this window knows: ideas in, prepared work out, the session's light.
  const working = session.state === "working";
  const desk = {
    state: (today?.brief?.kind === "evening" ? "done" : working ? "working" : "idle") as PetState,
    inTray: ideas.length,
    outTray: summaries?.filter((p) => p.prepared?.status === "ready" && p.prepared.work).length,
    signal: working,
  };

  let screen;
  let title = "Today";
  let sub: ReactNode = dateLabel.format(new Date());
  let pane: ReactNode | null = <DeskPane desk={desk} />;
  if (route.view === "project") {
    const name = nameOf(route.projectId);
    title = name ?? "Project";
    sub =
      route.projectId === focusId ? (
        "Your focus"
      ) : (
        <button type="button" className="text-button inline" onClick={() => pick(route.projectId)}>
          Work on this now
        </button>
      );
    screen = name ? <ProjectLive key={route.projectId} projectId={route.projectId} {...(route.mode ? { mode: route.mode } : {})} /> : null;
  } else if (route.view === "memory") {
    [title, sub, pane] = ["What I remember", undefined, null];
    const projectId = route.projectId ?? focusId ?? projects?.[0]?.id;
    screen = <MemoryLive projects={projects ?? []} {...(projectId ? { projectId } : {})} onSelectProject={(id) => setRoute({ view: "memory", projectId: id })} />;
  } else if (route.view === "connections") {
    [title, sub, pane] = ["Connections", undefined, null];
    screen = <ConnectionsLive projects={projects ?? null} />;
  } else if (route.view === "schedule") {
    [title, sub, pane] = ["Schedule", undefined, null];
    screen = <ScheduleLive projects={projects ?? null} />;
  } else if (route.view === "calendar") {
    [title, sub, pane] = ["TARS's calendar", undefined, null];
    screen = <CalendarLive projects={summaries} />;
  } else if (!live || !today) {
    screen = (
      <div className="screen chat-screen">
        <div className="chat-scroll">
          <RetryNote what="Today" onRetry={retryToday ?? (() => undefined)} />
        </div>
      </div>
    );
  } else {
    const brief = today.brief;
    pane = (
      <DeskPane
        desk={desk}
        routines={today.routines}
        // A routine row scrolls the thread to that brief, when it is the one shown.
        {...(brief ? { onRoutine: (id: string) => id === brief.kind && scrollWithin(document.getElementById(`msg-${brief.key}`), ".chat-scroll", "start", true) } : {})}
      />
    );
    screen = (
      <Home
        now={Date.now()}
        {...live.helpers}
        projects={summaries}
        {...(cloud.honest ? { cloud: cloud.honest } : {})}
        {...(focusId ? { focusProjectId: focusId } : {})}
        brief={today.brief}
        {...(today.schedule ? { schedule: today.schedule } : {})}
        {...(today.reentry ? { reentry: today.reentry } : {})}
        {...(today.tradeoff ? { tradeoff: today.tradeoff } : {})}
        {...(today.error ? { briefError: today.error } : {})}
        onBriefShown={today.onBriefShown}
        onResolveTradeoff={today.onResolveTradeoff}
        {...(today.nudge ? { nudge: today.nudge } : {})}
        onNudge={async (choice) => {
          if (!today.nudge) return;
          const projectId = await today.onNudge(today.nudge.nudgeId, choice);
          if (choice === "finish") open(projectId); // the user's click opens the project's draft
        }}
        ideas={ideas}
        brainDump={live.brainDump}
        onCaptured={() => void loadIdeas()}
        onStart={(projectId, mode) => {
          pick(projectId); // accepting the recommended start is the user's pick
          if (session.state === "idle") session.onEvent("start"); // and their explicit start
          setRoute({ view: "project", projectId, mode });
        }}
        onOpenProject={open}
      />
    );
  }

  return (
    <Shell
      route={route}
      today={today ? todayPreview(today.brief, today.schedule, summaries ?? []) : { text: "Could not load. Nothing was lost", warn: true }}
      projects={summaries && summaries.map((p) => ({ id: p.id, name: p.name, focus: p.id === focusId, preview: rowPreview(p, { helpers, ...(today?.nudge ? { nudgeProjectId: today.nudge.projectId } : {}) }) }))}
      title={title}
      sub={sub}
      pane={pane}
      onCreateProject={create}
      account={{ signedIn: cloud.signedIn, busy: cloud.signingIn, onSignIn: () => void cloud.signIn().then(loadIdeas) }}
      pet={{
        visible: petVisible,
        onToggle: () => {
          void window.companion.setPetVisible(!petVisible);
          setPetVisible(!petVisible);
        },
      }}
      session={{ state: session.state, ...(session.error ? { error: session.error } : {}), onEvent: session.onEvent }}
      onNavigate={setRoute}
      onStop={stop}
    >
      {screen}
    </Shell>
  );
  }
}
