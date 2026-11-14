// The full app window: routes between Today, a project, memory and connections. Focus changes
// only when the user picks a project here (switchProject with userInitiated: true).
import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useState } from "react";
import type { CaptureInput } from "@companion/domain";
import { api } from "../../../../convex/_generated/api";
import { Home } from "./Home";
import { Boundary, ConnectionsLive, MemoryLive, ProjectLive, useCloud, useProjectSummaries } from "./live";
import { recommendStart } from "./recommend";
import { Shell, Stopped, type Route } from "./Shell";

const dateLabel = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });

export function App() {
  const cloud = useCloud();
  const [route, setRoute] = useState<Route>({ view: "today" });
  const [stopped, setStopped] = useState(false);
  const [petVisible, setPetVisible] = useState(true);
  const [ideas, setIdeas] = useState<CaptureInput[]>([]);

  const projects = useQuery(api.projects.listProjects, cloud.ready ? {} : "skip");
  const focus = useQuery(api.projects.getFocus, cloud.ready ? {} : "skip");
  const summaries = useProjectSummaries(projects);
  const switchProject = useMutation(api.projects.switchProject);
  const createProject = useMutation(api.projects.createProject);

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

  if (stopped) return <Stopped {...(nameOf(focusId) ? { projectName: nameOf(focusId)! } : {})} onResume={() => setStopped(false)} />;

  let screen;
  if (route.view === "project") {
    const name = nameOf(route.projectId);
    screen = name ? (
      <ProjectLive
        key={route.projectId}
        projectId={route.projectId}
        name={name}
        isFocus={route.projectId === focusId}
        {...(route.mode ? { mode: route.mode } : {})}
        onMakeFocus={() => pick(route.projectId)}
        onStop={() => setStopped(true)}
      />
    ) : null;
  } else if (route.view === "memory") {
    const projectId = route.projectId ?? focusId ?? projects?.[0]?.id;
    screen = <MemoryLive projects={projects ?? []} {...(projectId ? { projectId } : {})} onSelectProject={(id) => setRoute({ view: "memory", projectId: id })} />;
  } else if (route.view === "connections") {
    screen = <ConnectionsLive projects={projects ?? null} />;
  } else {
    screen = (
      <Home
        dateLabel={dateLabel.format(new Date())}
        projects={summaries}
        {...(cloud.honest ? { cloud: cloud.honest } : {})}
        {...(focusId ? { focusProjectId: focusId } : {})}
        recommendation={summaries ? recommendStart(summaries, focusId, new Date().toISOString()) : null}
        signedIn={cloud.signedIn === true}
        ideas={ideas}
        onCapture={async (text) => {
          const receipt = await window.companion.saveCapture({ text, origin: "typed" });
          await loadIdeas();
          return receipt.summary;
        }}
        onStart={(projectId, mode) => {
          pick(projectId); // accepting the recommended start is the user's pick
          setRoute({ view: "project", projectId, mode });
        }}
        onOpenProject={(projectId) => setRoute({ view: "project", projectId })}
        onCreateProject={async (name) => void (await createProject({ name }))}
      />
    );
  }

  return (
    <Shell
      route={route}
      projects={summaries && summaries.map((p) => ({ id: p.id, name: p.name, ...(p.prepared?.status === "needs-retry" ? { note: "Needs retry" } : {}) }))}
      {...(focusId ? { focusProjectId: focusId } : {})}
      account={{ signedIn: cloud.signedIn, busy: cloud.signingIn, onSignIn: () => void cloud.signIn().then(loadIdeas) }}
      pet={{
        visible: petVisible,
        onToggle: () => {
          void window.companion.setPetVisible(!petVisible);
          setPetVisible(!petVisible);
        },
      }}
      onNavigate={setRoute}
      onStop={() => setStopped(true)}
    >
      <Boundary key={JSON.stringify(route)}>{screen}</Boundary>
    </Shell>
  );
}
