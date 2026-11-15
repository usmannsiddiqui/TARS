// The full app's frame: where am I (the glass rail + title), the one next thing (each screen's single
// accent action) and how do I stop ("Stop for now", always in the same corner, the same size as its neighbour).
// The rail follows a desktop sidebar: icon rows for each place, a "Projects" disclosure with the focus
// project's own items under a guide line, and the account as one compact row at the foot.
import { useState, type ReactNode } from "react";
import { RECAP_EMPTY, type ClosingRecap, type RecapList } from "@companion/domain/recap";
import type { SelfTextResult } from "../main/self-text";
import type { ProjectSummary, SessionEvent, SessionState } from "./model";
import { Desk } from "./Desk";

export type Route =
  | { view: "today" }
  | { view: "projects" }
  | { view: "schedule" }
  | { view: "calendar" }
  | { view: "project"; projectId: string; mode?: "help" | "improve" }
  | { view: "memory"; projectId?: string }
  | { view: "connections" };

/** One project as the rail shows it; `prepared`, `next` and `open` are listed under the focus project. */
export type RailProject = { id: string; name: string; note?: string; prepared?: string; next?: string; open: number };

/** The rail's view of a project: its retry note, and the items listed under it when it is the focus. */
export const railProject = (p: ProjectSummary): RailProject => ({
  id: p.id,
  name: p.name,
  ...(p.prepared?.status === "needs-retry" ? { note: "Needs retry" } : {}),
  ...(p.prepared?.work ? { prepared: p.prepared.work.title, next: p.prepared.work.nextAction } : {}),
  open: p.commitments.filter((c) => c.state === "open" || c.state === "waiting").length,
});

export type ShellProps = {
  route: Route;
  projects: RailProject[] | null;
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

// One line-icon set: 20-unit grid, 1.5 stroke, currentColor, round joins.
const ICON = {
  today: "M10 6.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7ZM10 2.5v1.5M10 16v1.5M2.5 10H4M16 10h1.5M4.7 4.7l1.06 1.06M14.24 14.24l1.06 1.06M4.7 15.3l1.06-1.06M14.24 5.76l1.06-1.06",
  projects: "M2.75 5.5a1 1 0 0 1 1-1h3.7l1.6 1.75h7.2a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3.75a1 1 0 0 1-1-1Z",
  schedule: "M4.25 4.25h11.5a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5v-10a1.5 1.5 0 0 1 1.5-1.5ZM2.75 8.25h14.5M6.75 2.5v3.5M13.25 2.5v3.5M6.5 11.5h1.5M9.25 11.5h1.5M12 11.5h1.5M6.5 14h1.5M9.25 14h1.5",
  calendar: "M4.25 4.25h11.5a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5v-10a1.5 1.5 0 0 1 1.5-1.5ZM2.75 8.25h14.5M6.75 2.5v3.5M13.25 2.5v3.5M6.25 10.75h7.5v3.75h-7.5ZM8.25 12.25v.75M11.75 12.25v.75",
  connections: "M8.25 11.75l3.5-3.5M9 6.75l1.6-1.6a3 3 0 0 1 4.25 4.25L13.25 11M11 13.25l-1.6 1.6a3 3 0 0 1-4.25-4.25L6.75 9",
  memory: "M5.75 2.75h8.5a1 1 0 0 1 1 1v13.5L10 13.75l-5.25 3.5V3.75a1 1 0 0 1 1-1Z",
  group: "M2.75 7a1 1 0 0 1 1-1h3.7l1.6 1.75h7.2a1 1 0 0 1 1 1v6.75a1 1 0 0 1-1 1H3.75a1 1 0 0 1-1-1ZM4.75 3.75h4l1.25 1.25h6.25",
  person: "M10 3.25a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM4 16.75a6 6 0 0 1 12 0",
  chevron: "M6.5 8.25 10 11.75l3.5-3.5",
} as const;

function Icon({ name }: { name: keyof typeof ICON }) {
  return (
    <svg className="icon" width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
      <path d={ICON[name]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Shell({ route, projects, focusProjectId, account, pet, session, onNavigate, onStop, children }: ShellProps) {
  const next = SESSION_BUTTON[session.state];
  const [projectsOpen, setProjectsOpen] = useState(true);
  const row = (target: Route, icon: keyof typeof ICON, label: string, note?: string) => (
    <button type="button" className="rail-item" aria-current={isCurrent(route, target) ? "page" : undefined} onClick={() => onNavigate(target)}>
      <Icon name={icon} />
      <span className="rail-name">{label}</span>
      {note && <span className="rail-note" data-kind={note === "Focus" ? "focus" : "retry"}>{note}</span>}
    </button>
  );
  const place = (target: Route, icon: keyof typeof ICON, label: string) => <li key={target.view}>{row(target, icon, label)}</li>;

  return (
    <div className="shell">
      <nav className="rail" aria-label="TARS">
        <div className="brand">
          <Desk state="idle" signal={false} variant="mini" />
          <span className="wordmark">TARS</span>
        </div>
        <ul className="rail-list">
          {place({ view: "today" }, "today", "Today")}
          {place({ view: "projects" }, "projects", "Projects")}
          {place({ view: "schedule" }, "schedule", "Schedule")}
          {place({ view: "calendar" }, "calendar", "TARS's calendar")}
          {place({ view: "connections" }, "connections", "Connections")}
          {place({ view: "memory" }, "memory", "What I remember")}
        </ul>

        <section className="rail-section">
          <h2 className="rail-heading">
            <button type="button" className="rail-disclosure" id="rail-projects" aria-expanded={projectsOpen} aria-controls="rail-projects-list" onClick={() => setProjectsOpen(!projectsOpen)}>
              Projects
              <Icon name="chevron" />
            </button>
          </h2>
          <div id="rail-projects-list" hidden={!projectsOpen}>
            {projects === null ? (
              <p className="rail-empty">Projects appear once the cloud answers.</p>
            ) : projects.length === 0 ? (
              <p className="rail-empty">No projects yet.</p>
            ) : (
              <ul className="rail-list" aria-labelledby="rail-projects">
                {projects.map((p) => {
                  const focus = p.id === focusProjectId;
                  const items = focus ? [p.prepared, p.next, p.open > 0 ? `${p.open} open commitment${p.open === 1 ? "" : "s"}` : undefined].filter(Boolean) : [];
                  return (
                    <li key={p.id}>
                      {row({ view: "project", projectId: p.id }, "group", p.name, focus ? "Focus" : p.note)}
                      {focus && (
                        <ul className="rail-children" aria-label={`In ${p.name}`}>
                          {items.map((text) => (
                            <li key={text} className="rail-child">
                              {text}
                            </li>
                          ))}
                          <li>
                            <button type="button" className="rail-child rail-all" aria-label={`View all: ${p.name}`} onClick={() => onNavigate({ view: "project", projectId: p.id })}>
                              View all
                            </button>
                          </li>
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        <div className="rail-foot">
          <span className="rail-account">
            <Icon name="person" />
            {account.signedIn === null ? "Checking sign-in…" : account.signedIn ? "Signed in" : "Not signed in"}
          </span>
          {account.signedIn === false && (
            <button type="button" className="text-button" onClick={account.onSignIn} disabled={account.busy}>
              {account.busy ? "Waiting for your browser…" : "Sign in"}
            </button>
          )}
          <button type="button" className="text-button rail-pet" aria-pressed={!pet.visible} onClick={pet.onToggle}>
            {pet.visible ? "Hide pet" : "Show pet"}
          </button>
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

/** What happened to the recap text, in plain words. "off": Texts to me is off, so nothing is said. */
export type RecapTextState = SelfTextResult | "off" | "sending";
const TEXT_RESULT: Record<Exclude<RecapTextState, "off">, string> = {
  sending: "Sending this to your phone…",
  sent: "Sent to your phone.",
  "not-permitted": "macOS did not allow TARS to use Messages.",
  "no-messages-account": "There is no Messages account on this Mac.",
  failed: "The text to your phone did not send.",
};

function RecapSection({ heading, list, empty }: { heading: string; list: RecapList; empty: string }) {
  const id = `recap-${heading.toLowerCase()}`;
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="block-title">
        {heading}
      </h2>
      {list.items.length === 0 ? (
        <p className="small">{empty}</p>
      ) : (
        <ul className="plain recap">
          {list.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
          {list.more > 0 && <li>and {list.more} more</li>}
        </ul>
      )}
    </section>
  );
}

/** The screen after "Stop for now": nothing new starts, the place is kept, and today's recap is shown. */
export function Stopped({
  projectName,
  note,
  recap,
  text,
  onResume,
}: {
  projectName?: string;
  note?: string;
  /** undefined while it loads; absent lists are never invented. */
  recap?: ClosingRecap;
  text?: { state: RecapTextState; onSendAgain(): void };
  onResume(): void;
}) {
  return (
    <main className="stopped">
      <section className="stopped-slab" aria-labelledby="stopped-h">
        <div className="stopped-text">
          <h1 id="stopped-h">Stopped for now.</h1>
          <p>{projectName ? `${projectName} is where you left it.` : "Your place is kept."} Nothing new will start until you come back.</p>
          {note && <p role="alert">{note}</p>}
          {recap && (
            <>
              <RecapSection heading="Done" list={recap.done} empty={RECAP_EMPTY.done} />
              <RecapSection heading="Parked" list={recap.parked} empty={RECAP_EMPTY.parked} />
              <RecapSection heading="Left" list={recap.left} empty={RECAP_EMPTY.left} />
            </>
          )}
          {text && text.state !== "off" && (
            <p className="small" role="status">
              {TEXT_RESULT[text.state]}{" "}
              {text.state !== "sending" && (
                <button type="button" className="text-button" onClick={text.onSendAgain}>
                  Send again
                </button>
              )}
            </p>
          )}
          <button type="button" className="secondary" onClick={onResume} autoFocus>
            Come back
          </button>
        </div>
        <div className="stopped-figure">
          <Desk state="idle" signal={false} />
        </div>
      </section>
    </main>
  );
}
