// The full app's frame: where am I (rail + title), the one next thing (each screen's single amber
// action) and how do I stop ("Stop for now", always in the same corner, the same size as its neighbour).
import type { ReactNode } from "react";
import type { SessionEvent, SessionState } from "./model";
import { PetFigure } from "./ui";

export type Route =
  | { view: "today" }
  | { view: "project"; projectId: string; mode?: "help" | "improve" }
  | { view: "memory"; projectId?: string }
  | { view: "connections" };

export type ShellProps = {
  route: Route;
  projects: { id: string; name: string; note?: string }[] | null;
  focusProjectId?: string;
  account: { signedIn: boolean | null; onSignIn(): void; busy: boolean };
  pet: { visible: boolean; onToggle(): void };
  /** Explicit work-session controls; "Stop for now" (onStop) ends the session and starts nothing. */
  session: { state: SessionState; error?: string; onEvent(event: Exclude<SessionEvent, "stop">): void };
  onNavigate(route: Route): void;
  onStop(): void;
  children: ReactNode;
};

const isCurrent = (route: Route, target: Route) =>
  route.view === target.view && (target.view !== "project" || (route.view === "project" && route.projectId === target.projectId));

const SESSION_BUTTON = {
  idle: { event: "start", label: "Start working" },
  working: { event: "break", label: "Take a break" },
  break: { event: "resume", label: "Back from break" },
} as const;

export function Shell({ route, projects, focusProjectId, account, pet, session, onNavigate, onStop, children }: ShellProps) {
  const next = SESSION_BUTTON[session.state];
  const item = (target: Route, label: string, note?: string) => (
    <li key={target.view === "project" ? target.projectId : target.view}>
      <button
        type="button"
        className="rail-item"
        aria-current={isCurrent(route, target) ? "page" : undefined}
        onClick={() => onNavigate(target)}
      >
        <span className="rail-name">{label}</span>
        {note && <span className="rail-note" data-kind={note === "Focus" ? "focus" : "retry"}>{note}</span>}
      </button>
    </li>
  );

  return (
    <div className="shell">
      <nav className="rail" aria-label="TARS">
        <div className="brand">
          <PetFigure state="idle" variant="mark" className="brand-mark" />
          <span className="wordmark">TARS</span>
        </div>
        <ul className="rail-list">{item({ view: "today" }, "Today")}</ul>
        <h2 className="rail-heading" id="rail-projects">
          Projects
        </h2>
        {projects === null ? (
          <p className="rail-empty">Projects appear once the cloud answers.</p>
        ) : projects.length === 0 ? (
          <p className="rail-empty">No projects yet.</p>
        ) : (
          <ul className="rail-list" aria-labelledby="rail-projects">
            {projects.map((p) => item({ view: "project", projectId: p.id }, p.name, p.id === focusProjectId ? "Focus" : p.note))}
          </ul>
        )}
        <ul className="rail-list rail-after">
          {item({ view: "memory" }, "What I remember")}
          {item({ view: "connections" }, "Connections")}
        </ul>
        <div className="rail-foot">
          <span className="signage" aria-hidden="true">
            T-01
          </span>
          <button type="button" className="text-button" aria-pressed={!pet.visible} onClick={pet.onToggle}>
            {pet.visible ? "Hide pet" : "Show pet"}
          </button>
          {account.signedIn === false && (
            <button type="button" className="text-button" onClick={account.onSignIn} disabled={account.busy}>
              {account.busy ? "Waiting for your browser…" : "Sign in"}
            </button>
          )}
        </div>
      </nav>
      <main className="canvas">
        <div className="canvas-stop" role="group" aria-label="Work session">
          {session.error && <span className="session-state" role="alert">{session.error}</span>}
          {session.state !== "idle" && <span className="session-state">{session.state === "working" ? "Working" : "On a break"}</span>}
          <button type="button" className="secondary" onClick={() => session.onEvent(next.event)}>
            {next.label}
          </button>
          <button type="button" className="secondary" onClick={onStop}>
            Stop for now
          </button>
        </div>
        {children}
      </main>
    </div>
  );
}

/** The screen after "Stop for now": nothing new starts, the place is kept. */
export function Stopped({ projectName, note, onResume }: { projectName?: string; note?: string; onResume(): void }) {
  return (
    <main className="stopped">
      <section className="stopped-slab" aria-labelledby="stopped-h">
        <div className="stopped-text">
          <h1 id="stopped-h">Stopped for now.</h1>
          <p>{projectName ? `${projectName} is where you left it.` : "Your place is kept."} Nothing new will start until you come back.</p>
          {note && <p role="alert">{note}</p>}
          <button type="button" className="secondary" onClick={onResume} autoFocus>
            Come back
          </button>
        </div>
        <div className="stopped-figure scene" aria-hidden="true">
          <PetFigure state="idle" variant="hero" className="hero-pet" />
        </div>
      </section>
    </main>
  );
}
