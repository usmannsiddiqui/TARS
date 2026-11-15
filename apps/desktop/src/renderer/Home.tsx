// Today across every project, from the brief service: the morning brief (meetings and real deadlines
// apart from suggested work, one recommended start with its reason), the evening recap when it is the
// newer brief, or the way back in after days away. Alternatives, quick capture and the full backlog
// stay one click away; adding a project lives on the project index. Presentational: data and actions arrive as props.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { preparedNote, type Brief, type CapturedIdea, type HardItem, type Honest, type PetState, type ProjectSummary, type Reentry, type Tradeoff, type TradeoffChoice } from "./model";
import { Composer } from "./Composer";
import { Desk } from "./Desk";
import { formatWhen, NewProject, reason, SOURCE_NAME, StateNote, StateTag } from "./ui";

export type HomeProps = {
  dateLabel: string;
  /** null while projects are unavailable; `cloud` then says why. */
  projects: ProjectSummary[] | null;
  cloud?: Honest;
  focusProjectId?: string;
  /** The brief to show: undefined while loading, null when none is prepared yet. */
  brief: Brief | null | undefined;
  /** Only after days away: what changed and one way back in. */
  reentry?: Reentry;
  /** One open tradeoff for a new commitment; the user's choice ends it. */
  tradeoff?: Tradeoff;
  /** The brief service could not be set up or reached. */
  briefError?: string;
  ideas: CapturedIdea[];
  /** A work session is running (the desk's signal light). */
  sessionWorking: boolean;
  /** A capture was saved on this Mac: reload the list of ideas. */
  onCaptured(): void;
  onStart(projectId: string, mode: "help" | "improve"): void;
  onOpenProject(projectId: string): void;
  onCreateProject(name: string): Promise<void>;
  /** The brief was actually shown here, so it is never offered as news again. */
  onBriefShown(key: string): void;
  onResolveTradeoff(commitmentId: string, choice: TradeoffChoice): Promise<void>;
};

export function Home(props: HomeProps) {
  const { projects, brief, reentry, onBriefShown } = props;
  const evening = brief?.kind === "evening";
  const action = reentry ? reentry.recommendedAction : evening ? undefined : brief?.recommendedAction;
  const why = reentry ? reentry.reason : brief?.reason;
  // The brief names the project of each item; the recommended start is one of them.
  const projectId = action === undefined ? undefined : [...(reentry?.urgent ?? []), ...(brief?.hard ?? []), ...(brief?.suggested ?? [])].find((i) => i.text === action)?.projectId;
  const recommended = projects?.find((p) => p.id === projectId);
  const others = projects?.filter((p) => p.id !== recommended?.id) ?? [];
  const focusName = projects?.find((p) => p.id === props.focusProjectId)?.name;
  const backlog = (projects ?? []).map((p) => ({ p, open: p.commitments.filter((c) => c.state === "open" || c.state === "waiting") })).filter((g) => g.open.length > 0);
  const backlogCount = backlog.reduce((n, g) => n + g.open.length, 0);
  const nameOf = (id: string) => projects?.find((p) => p.id === id)?.name;
  const preparedCount = projects?.filter((p) => p.prepared?.status === "ready" && p.prepared.work).length;
  // The desk shows only what this screen already knows: ideas in, prepared work out, the session's light.
  const desk = {
    state: (evening ? "done" : props.sessionWorking ? "working" : "idle") as PetState,
    inTray: props.ideas.length,
    outTray: preparedCount,
    signal: props.sessionWorking,
  };
  const othersRegion = projects !== null && projects.length > 0 && (
    <section className="free" aria-labelledby="others-h">
      <h2 id="others-h" className="free-title">
        Other ways to start
      </h2>
      {others.length === 0 ? (
        <p className="quiet">No other projects.</p>
      ) : (
        <ul className="pills" aria-labelledby="others-h">
          {others.map((p) => (
            <li key={p.id}>
              <button type="button" className="secondary" onClick={() => props.onOpenProject(p.id)} aria-label={`Open ${p.name}`} aria-describedby={`others-${p.id}`}>
                {p.name}
                <StateTag state={preparedNote(p)} id={`others-${p.id}`} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
  const heroFrame = { intro: props.dateLabel, desk, after: othersRegion };
  const shownKey = !reentry && brief && !brief.delivered ? brief.key : undefined;

  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (!shownKey || reported.current === shownKey) return; // one report per showing
    reported.current = shownKey;
    onBriefShown(shownKey);
  }, [shownKey, onBriefShown]);

  const hero =
    projects === null ? (
      <Hero title="Recommended start" {...heroFrame}>
        <StateNote state={props.cloud ?? { kind: "loading" }} />
        <p>You can still capture ideas; they wait safely on this Mac.</p>
      </Hero>
    ) : projects.length === 0 ? (
      <Hero title="Start with a project" {...heroFrame}>
        <p className="start-step">Name the first thing you are working on. You can add the others later.</p>
        <NewProject onCreate={props.onCreateProject} />
      </Hero>
    ) : evening && brief ? (
      <Hero title="Evening recap" {...heroFrame}>
        {brief.items.length === 0 ? (
          <StateNote state={{ kind: "empty", detail: "Nothing finished or parked today. That is fine." }} />
        ) : (
          <ul className="plain recap">
            {brief.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
        <p className="small">Prepared {formatWhen(new Date(brief.preparedAt).toISOString())}. Nothing else is needed tonight.</p>
      </Hero>
    ) : (
      <Hero title={reentry ? "One way back in" : "Recommended start"} {...heroFrame} project={recommended?.name}>
        {props.briefError && <StateNote state={{ kind: "needs-retry", detail: props.briefError }} />}
        {brief === undefined && !reentry ? (
          <StateNote state={{ kind: "loading", detail: "Reading today's brief…" }} />
        ) : action ? (
          <>
            <Typed key={action} className="start-step" text={action} />
            {why && (
              <p className="start-reason">
                <span className="why">Why this one:</span> {why}
              </p>
            )}
            {recommended && (
              <div className="actions">
                <button type="button" className="primary" onClick={() => props.onStart(recommended.id, "help")}>
                  Help me start
                </button>
                <button type="button" className="secondary" onClick={() => props.onStart(recommended.id, "improve")}>
                  Improve content first
                </button>
              </div>
            )}
          </>
        ) : (
          <StateNote
            state={{
              kind: "empty",
              detail: brief === null && !reentry ? "Your first brief is prepared at 9:00. Pick any project below, or capture what is on your mind." : "Nothing is prepared or due yet. Pick any project below, or capture what is on your mind.",
            }}
          />
        )}
      </Hero>
    );

  // What TARS holds right now, from data already on this screen. Nothing here is estimated or invented.
  const readout: [key: string, value: string][] = [
    ["Projects", projects === null ? "waiting for the cloud" : String(projects.length)],
    [
      evening ? "Recap" : "Brief",
      brief === undefined ? (projects === null ? "not yet read" : "reading") : brief === null ? "first one at 9:00" : `prepared ${formatWhen(new Date(brief.preparedAt).toISOString())}`,
    ],
    ...(projects
      ? [
          ["Open items", String(backlogCount)] as [string, string],
          ["Prepared", String(preparedCount)] as [string, string],
        ]
      : []),
    ["Ideas on this Mac", String(props.ideas.length)],
    ...(brief ? [["Out of date", brief.stale.length === 0 ? "none" : brief.stale.map((s) => s.name).join(", ")] as [string, string]] : []),
  ];

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Today</h1>
        <p className="screen-sub">
          <span>{props.dateLabel}</span>
          <span className="sub-sep" aria-hidden="true" />
          <span className={focusName ? "sub-focus" : undefined}>{focusName ? `Focus: ${focusName}` : "No project chosen yet"}</span>
        </p>
        <ul className="readout" aria-label="What TARS has now">
          {readout.map(([key, value]) => (
            <li key={key}>
              <span className="readout-key">{key}</span> {value}
            </li>
          ))}
        </ul>
      </header>

      {reentry && projects && projects.length > 0 && (
        <p className="reentry-lead">
          Welcome back. Since {formatWhen(reentry.since)}: what changed, what is genuinely urgent, and one manageable way back in. Nothing was moved,
          deleted or sent while you were away.
        </p>
      )}
      {hero}

      <div className="home-grid">
        <div className="home-main">
          {projects !== null && projects.length > 0 && (
            <>
              {props.tradeoff && <TradeoffFlag tradeoff={props.tradeoff} onResolve={props.onResolveTradeoff} />}

              {reentry ? (
                <>
                  <section className="block" aria-labelledby="changed-h">
                    <h2 id="changed-h" className="block-title">
                      What changed <span className="count num">{reentry.changedCount}</span>
                    </h2>
                    {reentry.changed.length === 0 ? (
                      <StateNote state={{ kind: "empty", detail: "Nothing new arrived from your sources." }} />
                    ) : (
                      <ul className="plain">
                        {reentry.changed.map((c) => (
                          <li key={c.evidenceId}>
                            {c.text}
                            <span className="quiet"> · {formatWhen(c.occurredAt)}</span>
                          </li>
                        ))}
                        {reentry.changedCount > reentry.changed.length && <li className="quiet">and {reentry.changedCount - reentry.changed.length} more in your sources</li>}
                      </ul>
                    )}
                  </section>
                  <HardList title="Genuinely urgent" id="urgent-h" items={reentry.urgent} empty="Nothing is due in the next two days." nameOf={nameOf} />
                </>
              ) : (
                brief &&
                !evening && (
                  <>
                    <HardList title="Meetings and deadlines" id="hard-h" items={brief.hard} triage={brief.triage} empty="No meetings or due dates in your sources." nameOf={nameOf} />
                    <section className="block" aria-labelledby="suggested-h">
                      <h2 id="suggested-h" className="block-title">
                        Suggested work
                      </h2>
                      <p className="quiet small">Suggestions, not deadlines. Nothing here is scheduled for you.</p>
                      {brief.suggested.length === 0 ? (
                        <StateNote state={{ kind: "empty", detail: "Nothing suggested yet." }} />
                      ) : (
                        <ul className="plain">
                          {brief.suggested.map((s) => (
                            <li key={`${s.projectId}:${s.text}`}>
                              {s.text}
                              <span className="quiet"> · {nameOf(s.projectId) ?? "a project"}</span>
                              {s.commitmentId && <TriageNote triage={brief.triage} id={s.commitmentId} />}
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                    {brief.stale.length > 0 && (
                      <section className="block" aria-labelledby="stale-h">
                        <h2 id="stale-h" className="block-title">
                          May be out of date
                        </h2>
                        {brief.stale.map((s) => (
                          <StateNote key={s.name} state={{ kind: "stale", detail: `${s.name}: ${s.lastCheckedAt ? `last checked ${formatWhen(s.lastCheckedAt)}` : "never checked"}` }} />
                        ))}
                      </section>
                    )}
                  </>
                )
              )}

              <details className="block backlog">
                <summary>
                  All open work <span className="count num">{backlogCount}</span>
                </summary>
                {backlog.length === 0 ? (
                  <p className="quiet">Nothing open across your projects.</p>
                ) : (
                  backlog.map(({ p, open }) => (
                    <section key={p.id} aria-label={`Open work in ${p.name}`}>
                      <h3 className="group-title">{p.name}</h3>
                      <ul className="plain">
                        {open.map((c) => (
                          <li key={c.id}>
                            {c.text}
                            {c.state === "waiting" && <span className="quiet"> · waiting on someone</span>}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))
                )}
              </details>
            </>
          )}
        </div>

        <aside className="home-side">
          <Composer {...(props.focusProjectId ? { projectId: props.focusProjectId } : {})} onSaved={props.onCaptured} />
          <section className="block" aria-labelledby="ideas-h">
            <h2 id="ideas-h" className="block-title">
              Captured ideas
            </h2>
            <p className="quiet">Saved on this Mac. Capturing never changes your focus.</p>
            {props.ideas.length === 0 ? (
              <StateNote state={{ kind: "empty", detail: "No ideas captured yet." }} />
            ) : (
              <ul className="ideas" aria-label="Captured ideas">
                {props.ideas.map((idea, i) => (
                  <li key={i}>{idea.text}</li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

/**
 * Today's hero, after the reference's choreography: a blurred two-line intro (decoration), TARS's words
 * under a black "speaking" label, then the actions as pills; TARS at the front desk on the right.
 */
function Hero({
  title,
  intro,
  project,
  desk,
  after,
  children,
}: {
  title: string;
  intro: string;
  project?: string | undefined;
  desk: Parameters<typeof Desk>[0];
  after: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="start tars-voice" aria-labelledby="start-h">
      <div className="start-body">
        <p className="start-intro" aria-hidden="true">
          <span>TARS, at the front desk</span>
          <span>{intro}</span>
        </p>
        <div className="start-meta">
          <h2 id="start-h" className="block-title">
            {title}
          </h2>
          {project && <p className="start-project">{project}</p>}
        </div>
        {children}
        {after}
      </div>
      <div className="start-figure">
        <Desk {...desk} />
      </div>
    </section>
  );
}

// Sentences typed once per app session: coming back to Today shows them whole.
const typedOnce = new Set<string>();

/**
 * TARS's sentence typed out (38 ms a character after 600 ms) behind an accent-coloured block cursor. The
 * whole sentence is one text node from the first frame, so it is read whole; CSS highlights only paint
 * the untyped rest transparent. Reduced motion, or a sentence already typed, shows it at once.
 */
function Typed({ text, className }: { text: string; className: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const node = ref.current?.firstChild;
    if (!node || typedOnce.has(text) || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rest = new Highlight();
    const cursor = new Highlight();
    CSS.highlights.set("type-rest", rest);
    CSS.highlights.set("type-cursor", cursor);
    const span = (from: number, to: number) => {
      const r = new Range();
      r.setStart(node, from);
      r.setEnd(node, to);
      return r;
    };
    const t0 = performance.now();
    let raf = 0;
    const frame = (t: number) => {
      const elapsed = t - t0;
      const typed = Math.max(0, Math.floor((elapsed - 600) / 38));
      rest.clear();
      cursor.clear();
      if (typed >= text.length) {
        typedOnce.add(text);
        CSS.highlights.delete("type-rest");
        CSS.highlights.delete("type-cursor");
        return;
      }
      const lit = elapsed >= 600 || Math.floor(elapsed / 500) % 2 === 0; // blinks while waiting, steady while typing
      if (lit) cursor.add(span(typed, typed + 1));
      rest.add(span(lit ? typed + 1 : typed, text.length));
      raf = requestAnimationFrame(frame);
    };
    frame(t0);
    return () => {
      cancelAnimationFrame(raf);
      CSS.highlights.delete("type-rest");
      CSS.highlights.delete("type-cursor");
    };
  }, [text]);
  return (
    <p ref={ref} className={className}>
      {text}
    </p>
  );
}

const TRIAGE_WORD = { prioritize: "Do first", defer: "Can wait", renegotiate: "Consider renegotiating" } as const;

function TriageNote({ triage, id }: { triage: Brief["triage"] | undefined; id: string }) {
  const t = triage?.find((x) => x.commitmentId === id);
  return t ? (
    <span className="quiet">
      {" "}
      · <span className="why">{TRIAGE_WORD[t.action]}:</span> {t.reason}
    </span>
  ) : null;
}

/** Meetings and real due dates, each with its source and, when it is not current, when it was last checked. */
function HardList({ title, id, items, triage, empty, nameOf }: { title: string; id: string; items: HardItem[]; triage?: Brief["triage"] | undefined; empty: string; nameOf(id: string): string | undefined }) {
  return (
    <section className="block" aria-labelledby={id}>
      <h2 id={id} className="block-title">
        {title}
      </h2>
      {items.length === 0 ? (
        <StateNote state={{ kind: "empty", detail: empty }} />
      ) : (
        <ul className="plain">
          {items.map((item) => (
            <li key={item.commitmentId}>
              {item.text}
              <span className="quiet">
                {" "}
                · {item.kind === "meeting" ? "meeting" : "due"} {formatWhen(item.dueAt)} · {nameOf(item.projectId) ?? "a project"}
                {item.sourceKind ? ` · from ${SOURCE_NAME[item.sourceKind] ?? item.sourceKind}` : " · no linked source"}
              </span>
              <TriageNote triage={triage} id={item.commitmentId} />
              {item.sourceKind && !item.current && (
                <StateNote state={{ kind: "stale", detail: `${item.lastCheckedAt ? `last checked ${formatWhen(item.lastCheckedAt)}` : "never checked"}; may have changed` }} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TradeoffFlag({ tradeoff, onResolve }: { tradeoff: Tradeoff; onResolve(commitmentId: string, choice: TradeoffChoice): Promise<void> }) {
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const choose = async (choice: TradeoffChoice) => {
    setState({ busy: true });
    try {
      await onResolve(tradeoff.commitmentId, choice);
      setState({ busy: false });
    } catch (err) {
      setState({ busy: false, error: reason(err) });
    }
  };
  return (
    <section className="block tradeoff" aria-labelledby="tradeoff-h">
      <h2 id="tradeoff-h" className="block-title">
        A new commitment competes
      </h2>
      <p>{tradeoff.text}</p>
      <div className="actions">
        <button type="button" className="secondary" disabled={state.busy} onClick={() => choose("keep")}>
          Keep both
        </button>
        <button type="button" className="secondary" disabled={state.busy} onClick={() => choose("defer")}>
          Defer the new one
        </button>
        <button type="button" className="secondary" disabled={state.busy} onClick={() => choose("renegotiate")}>
          Renegotiate a deadline
        </button>
      </div>
      <p className="quiet small">Your choice is recorded once. Nothing is moved, rescheduled or sent.</p>
      {state.error && <StateNote state={{ kind: "needs-retry", detail: state.error }} />}
    </section>
  );
}
