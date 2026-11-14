// The full app's frame: where am I (rail + title), the one next thing (each screen's single amber
// action) and how do I stop ("Stop for now", always in the same corner).
import type { ReactNode } from "react";
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
  onNavigate(route: Route): void;
  onStop(): void;
  children: ReactNode;
};

const isCurrent = (route: Route, target: Route) =>
  route.view === target.view && (target.view !== "project" || (route.view === "project" && route.projectId === target.projectId));

export function Shell({ route, projects, focusProjectId, account, pet, onNavigate, onStop, children }: ShellProps) {
  const item = (target: Route, label: string, note?: string) => (
    <li key={target.view === "project" ? target.projectId : target.view}>
      <button
        type="button"
        className="rail-item"
        aria-current={isCurrent(route, target) ? "page" : undefined}
        onClick={() => onNavigate(target)}
      >
        <span className="rail-name">{label}</span>
        {note && <span className="rail-note">{note}</span>}
      </button>
    </li>
  );

  return (
    <div className="shell">
      <nav className="rail" aria-label="Companion">
        <div className="brand">
          <PetFigure state="idle" size={22} />
          <span className="wordmark">Companion</span>
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
        <div className="canvas-stop">
          <button type="button" className="secondary" onClick={onStop}>
            Stop for now
          </button>
        </div>
        {children}
      </main>
    </div>
  );
}

/** The calm screen after "Stop for now": nothing new starts, the place is kept. */
export function Stopped({ projectName, onResume }: { projectName?: string; onResume(): void }) {
  return (
    <main className="stopped">
      <PetFigure state="idle" size={64} />
      <h1>Stopped for now.</h1>
      <p>{projectName ? `${projectName} is where you left it.` : "Your place is kept."} Nothing new will start until you come back.</p>
      <button type="button" className="secondary" onClick={onResume} autoFocus>
        Come back
      </button>
    </main>
  );
}
