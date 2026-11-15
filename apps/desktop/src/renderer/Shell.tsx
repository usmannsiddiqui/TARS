// The full app's frame, after rakazo's three panes: the list on the left (TARS at its mini desk, Today and
// the projects as two-line rows, "More" for the other places), one thread in the middle under a one-row
// header (the name toggles the right pane; the session controls and "Stop for now", always there), and
// TARS at the front desk on the right. Below 1024px the right pane becomes an overlay that starts closed.
import { createContext, useEffect, useState, type ReactNode } from "react";
import { RECAP_EMPTY, type ClosingRecap, type RecapList } from "@companion/domain/recap";
import { rowTime, type RowPreview, type SessionEvent, type SessionState, NOTHING_PREPARED } from "./model";
import { Boundary } from "./boundary";
import { Desk } from "./Desk";
import { NewProject, RetryNote } from "./ui";

export type Route =
  | { view: "today" }
  | { view: "schedule" }
  | { view: "calendar" }
  | { view: "project"; projectId: string; mode?: "help" | "improve" }
  | { view: "memory"; projectId?: string }
  | { view: "connections" };

/** One left-list row: a project, its second line (rowPreview) and whether it is the chosen focus. */
export type ProjectRow = { id: string; name: string; preview: RowPreview; focus: boolean };

/** Where a screen puts its own right-pane content (the project's draft and open items), and how it opens the pane. */
export const PaneSlot = createContext<{ slot: HTMLElement | null; open(): void }>({ slot: null, open: () => undefined });

export type ShellProps = {
  route: Route;
  /** The Today row's second line. */
  today: RowPreview;
  projects: ProjectRow[] | null;
  account: { signedIn: boolean | null; onSignIn(): void; busy: boolean };
  pet: { visible: boolean; onToggle(): void };
  /** Explicit work-session controls; "Stop for now" (onStop) ends the session and starts nothing. */
  session: { state: SessionState; error?: string; onEvent(event: Exclude<SessionEvent, "stop">): void };
  /** The header: the screen's name and the words beside it (the date, "Your focus"). */
  title: string;
  sub?: ReactNode;
  /** The right pane's content; null on the More screens, which span centre and right. */
  pane: ReactNode | null;
  onNavigate(route: Route): void;
  onCreateProject(name: string): Promise<void>;
  onStop(): void;
  children: ReactNode;
};

const isCurrent = (route: Route, target: Route) =>
  route.view === target.view && (target.view !== "project" || (route.view === "project" && route.projectId === target.projectId));
const MORE: { route: Route; icon: keyof typeof ICON; label: string }[] = [
  { route: { view: "schedule" }, icon: "schedule", label: "Schedule" },
  { route: { view: "calendar" }, icon: "calendar", label: "TARS's calendar" },
  { route: { view: "connections" }, icon: "connections", label: "Connections" },
  { route: { view: "memory" }, icon: "memory", label: "What I remember" },
];
const WIDE = "(min-width: 1024px)";

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
  plus: "M10 4.5v11M4.5 10h11",
  close: "M5.5 5.5l9 9M14.5 5.5l-9 9",
  desk: "M2.75 4.25h14.5v9.5H2.75ZM12.5 4.25v9.5M7 16.75h6M10 13.75v3",
  more: "M5 10h.01M10 10h.01M15 10h.01",
} as const;

function Icon({ name }: { name: keyof typeof ICON }) {
  return (
    <svg className="icon" width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
      <path d={ICON[name]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Row({ current, icon, name, time, preview, onClick }: { current: boolean; icon: keyof typeof ICON; name: string; time?: string; preview: RowPreview; onClick(): void }) {
  return (
    <button type="button" className="row" aria-current={current ? "page" : undefined} onClick={onClick}>
      <Icon name={icon} />
      <span className="row-main">
        <span className="row-line">
          <span className="row-name">{name}</span>
          {time && <span className="row-time num">{time}</span>}
        </span>
        {preview.text !== NOTHING_PREPARED && (
          <span key={preview.text} className="row-preview" data-warn={preview.warn || undefined}>
            {preview.text}
          </span>
        )}
      </span>
    </button>
  );
}

export function Shell({ route, today, projects, account, pet, session, title, sub, pane, onNavigate, onCreateProject, onStop, children }: ShellProps) {
  const next = SESSION_BUTTON[session.state];
  const [adding, setAdding] = useState(false);
  const onMore = MORE.some((m) => m.route.view === route.view);
  const [moreOpen, setMoreOpen] = useState(onMore);
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches);
  const [open, setOpen] = useState(wide);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const overlay = !wide && pane !== null;
  const now = Date.now();

  // The window crossing 1024px: docked and open above, an overlay that starts closed below (an event, never a timer).
  useEffect(() => {
    const query = matchMedia(WIDE);
    const change = () => {
      setWide(query.matches);
      setOpen(query.matches);
    };
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);

  // ⌘I the composer, Ctrl+(Shift+)Tab the next (previous) row, Esc closes the overlay.
  const order: Route[] = [{ view: "today" }, ...(projects ?? []).map((p): Route => ({ view: "project", projectId: p.id }))];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && overlay && open) setOpen(false);
      else if (e.key.toLowerCase() === "i" && e.metaKey) {
        e.preventDefault();
        document.querySelector<HTMLTextAreaElement>(".composer-pill textarea")?.focus();
      } else if (e.key === "Tab" && e.ctrlKey) {
        e.preventDefault();
        const at = order.findIndex((r) => isCurrent(route, r));
        onNavigate(order[(at + (e.shiftKey ? -1 : 1) + order.length) % order.length]!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="app3" data-pane={pane === null ? "none" : open ? "open" : "closed"} data-overlay={overlay || undefined}>
      <nav className="list" aria-label="TARS">
        <div className="list-top">
          <Desk state={session.state === "working" ? "working" : "idle"} signal={session.state === "working"} variant="mini" />
          <span className="wordmark">TARS</span>
          <button type="button" className="icon-button" aria-label="New project" aria-expanded={adding} onClick={() => setAdding(!adding)}>
            <Icon name="plus" />
          </button>
        </div>
        {adding && (
          <div className="list-add">
            <NewProject
              compact
              onCreate={async (name) => {
                await onCreateProject(name);
                setAdding(false);
              }}
            />
          </div>
        )}
        <Boundary name="the project list" fallback={(retry) => <RetryNote what="The project list" onRetry={retry} />}>
        <ul className="rows">
          <li>
            <Row current={route.view === "today"} icon="today" name="Today" {...(today.time ? { time: rowTime(today.time, now) } : {})} preview={today} onClick={() => onNavigate({ view: "today" })} />
          </li>
          {projects === null ? (
            <li className="list-empty">Projects appear once the cloud answers.</li>
          ) : (
            projects.map((p) => (
              <li key={p.id}>
                <Row
                  current={isCurrent(route, { view: "project", projectId: p.id })}
                  icon="group"
                  name={p.name}
                  {...(p.focus ? { time: "Focus" } : p.preview.time ? { time: rowTime(p.preview.time, now) } : {})}
                  preview={p.preview}
                  onClick={() => onNavigate({ view: "project", projectId: p.id })}
                />
              </li>
            ))
          )}
        </ul>
        </Boundary>

        <section className="more">
          <h2 className="rail-heading">
            <button type="button" className="rail-disclosure" id="more-h" aria-expanded={moreOpen} aria-controls="more-list" onClick={() => setMoreOpen(!moreOpen)}>
              More
              <Icon name="chevron" />
            </button>
          </h2>
          <ul id="more-list" className="rail-list" aria-labelledby="more-h" hidden={!moreOpen}>
            {MORE.map((m) => (
              <li key={m.label}>
                <button type="button" className="rail-item" aria-current={isCurrent(route, m.route) ? "page" : undefined} onClick={() => onNavigate(m.route)}>
                  <Icon name={m.icon} />
                  <span className="rail-name">{m.label}</span>
                </button>
              </li>
            ))}
          </ul>
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

      <main className="center">
        <header className="head">
          <div className="head-title">
            {pane === null ? (
              // The More screens keep their own h1; this is the same name, drawn where every screen's name sits.
              <p className="head-h" aria-hidden="true">
                {title}
              </p>
            ) : (
              <h1 className="head-h">
                <button type="button" className="head-name" aria-expanded={open} aria-controls="desk-pane" onClick={() => setOpen(!open)}>
                  {title}
                </button>
              </h1>
            )}
            {sub && <span className="head-sub">{sub}</span>}
          </div>
          <div className="head-session" role="group" aria-label="Work session">
            {session.error && (
              <span className="session-state" role="alert">
                {session.error}
              </span>
            )}
            {session.state !== "idle" && <span className="session-state">{session.state === "working" ? "Working" : "On a break"}</span>}
            <button type="button" className="secondary" onClick={() => session.onEvent(next.event)}>
              {next.label}
            </button>
            <button type="button" className="secondary stop" onClick={onStop}>
              Stop for now
            </button>
            {pane !== null && (
              <button type="button" className="icon-button" aria-label={open ? "Hide TARS's desk" : "Show TARS's desk"} aria-expanded={open} aria-controls="desk-pane" onClick={() => setOpen(!open)}>
                <Icon name="desk" />
              </button>
            )}
          </div>
        </header>
        <PaneSlot.Provider value={{ slot, open: () => setOpen(true) }}>
          {/* Keyed by the place: going somewhere else starts it fresh. */}
          <Boundary
            key={JSON.stringify(route)}
            name={title}
            fallback={(retry) => (
              <div className="screen chat-screen">
                <div className="chat-scroll">
                  <RetryNote what={title} onRetry={retry} />
                </div>
              </div>
            )}
          >
            {children}
          </Boundary>
        </PaneSlot.Provider>
      </main>

      {pane !== null && (
        <aside id="desk-pane" className="pane" aria-labelledby="pane-h" inert={!open}>
          <div className="pane-head">
            <h2 id="pane-h" className="sr-only">
              TARS at the front desk
            </h2>
            {overlay && (
              <button type="button" className="icon-button" aria-label="Close TARS's desk" onClick={() => setOpen(false)}>
                <Icon name="close" />
              </button>
            )}
          </div>
          <Boundary name="TARS's desk" fallback={(retry) => <RetryNote what="TARS's desk" onRetry={retry} />}>
            {pane}
          </Boundary>
          <div ref={setSlot} className="pane-slot" />
        </aside>
      )}
    </div>
  );
}

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
  onResume,
}: {
  projectName?: string;
  note?: string;
  /** undefined while it loads; absent lists are never invented. */
  recap?: ClosingRecap;
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
