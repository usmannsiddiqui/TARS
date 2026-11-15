// The compact panel the pet opens. Presentational: data and actions arrive as props.
import { useEffect, useRef } from "react";
import type { Transcript } from "../preload/index";
import type { BrainDumpProps } from "./BrainDump";
import { Composer } from "./Composer";
import { HelperCards, type HelperActions } from "./Helpers";
import type { HardItem, HelperRun, Honest, NudgeChoice, NudgeOffer, PetState, Receipt } from "./model";
import { NudgeCard, PET_LABEL, PetFigure, StateNote } from "./ui";

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayAndClock = new Intl.DateTimeFormat(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" });
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

export type PanelProps = {
  petState: PetState;
  /** TARS's helpers: preparations running (or failed) right now, one compact card each. */
  helpers: HelperRun[];
  helperActions: HelperActions;
  /** Render time, so "today" and "next" are decided once per showing. */
  now: number;
  projectId?: string;
  /** Where you left off: the focus project, what is prepared there, its next step, and when you were last here. */
  leftOff?: { project: string; artifact?: string; step?: string; at?: string };
  /** Today's brief: the meetings and real due dates, and the one recommended start. */
  today?: { hard: HardItem[]; start?: string };
  /** When the next brief is due, said when there is none yet. */
  nextBriefAt?: number;
  /** The cloud's own state, or a failed preparation. */
  state?: Honest;
  completion?: { done: string; next?: string };
  /** Tonight's recap, shown only because the user opened the panel. */
  recap?: { key: string; items: string[]; delivered: boolean };
  /** The recap was actually shown, so it is never offered again. */
  onRecapShown(key: string): void;
  /** One gentle nudge for a due commitment of yours, with its draft. */
  nudge?: NudgeOffer;
  onNudge(choice: NudgeChoice): Promise<void>;
  /** The focus project's newest instructed action. */
  receipt?: Receipt;
  note?: string;
  /** Opened for capture: the capture box takes focus instead of the first action. */
  capture?: boolean;
  /** A hold-to-talk transcript for the capture box, editable and unsaved. */
  transcript?: Transcript;
  /** Sorting a saved capture into projects, shown in the capture box. */
  brainDump?: BrainDumpProps;
  onOpenApp(): void;
  onStop(): void;
  onClose(): void;
};

/** At a glance: where you left off, what today holds, then "Open app" and "Stop for now", then capture. Escape closes it. */
export function Panel(props: PanelProps) {
  const first = useRef<HTMLButtonElement>(null);
  const { onClose, onRecapShown, capture } = props;
  const recapKey = props.recap && !props.recap.delivered ? props.recap.key : undefined;
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (!recapKey || reported.current === recapKey) return; // one report per showing
    reported.current = recapKey;
    onRecapShown(recapKey);
  }, [recapKey, onRecapShown]);
  useEffect(() => {
    if (!capture) first.current?.focus({ preventScroll: true }); // keep the context at the top in view
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, capture]);
  const composer = (
    <Composer
      {...(props.projectId ? { projectId: props.projectId } : {})}
      {...(props.transcript ? { transcript: props.transcript } : {})}
      {...(props.brainDump ? { brainDump: props.brainDump } : {})}
      autoFocus={capture === true}
    />
  );

  return (
    <main className="panel" aria-labelledby="panel-h">
      <header className="panel-head">
        <PetFigure state={props.petState} variant="mark" />
        <span className="wordmark">TARS</span>
        <span className="panel-state">{PET_LABEL[props.petState]}</span>
        <button type="button" className="text-button" onClick={props.onClose}>
          Close
        </button>
      </header>

      {props.completion ? (
        <>
        <section className="panel-body panel-card completion" aria-labelledby="panel-h">
          <h1 id="panel-h">Done</h1>
          <p>{props.completion.done}</p>
          <div className="actions equal stack">
            {props.completion.next && (
              <button type="button" className="secondary" ref={first} onClick={props.onOpenApp}>
                Optional next: {props.completion.next}
              </button>
            )}
            <button type="button" className="secondary" ref={props.completion.next ? undefined : first} onClick={props.onStop}>
              Stop for now
            </button>
          </div>
        </section>
        {capture && composer}
        </>
      ) : (
        <>
        <div className="panel-body panel-card">
          <section className="panel-glance" aria-labelledby="panel-h">
            <h1 id="panel-h" className="block-title">
              Where you left off
            </h1>
            {props.state && <StateNote state={props.state} />}
            {props.leftOff ? (
              <>
                <p className="panel-project">{props.leftOff.project}</p>
                {props.leftOff.artifact && <p className="panel-context">{props.leftOff.artifact}</p>}
                {props.leftOff.step && (
                  <p className="panel-next">
                    <span className="why">Next:</span> {props.leftOff.step}
                  </p>
                )}
                {props.leftOff.at && <p className="quiet small">Last here {dayAndClock.format(new Date(props.leftOff.at))}</p>}
              </>
            ) : (
              !props.state && <p className="quiet">Nothing from yesterday</p>
            )}
          </section>
          {/* Without the cloud nothing is known about today; the state above already says why. */}
          {(!props.state || props.state.kind === "needs-retry") && (
            <section className="panel-glance" aria-labelledby="today-h">
              <h2 id="today-h" className="block-title">
                Today
              </h2>
              {props.today ? (
                <TodayLines today={props.today} now={props.now} {...(props.leftOff?.step ? { step: props.leftOff.step } : {})} />
              ) : (
                <p className="quiet">
                  {props.nextBriefAt ? `No brief yet; the next one is at ${clock.format(props.nextBriefAt)}` : "No brief yet"}
                </p>
              )}
            </section>
          )}
          {props.nudge && <NudgeCard offer={props.nudge} className="panel-glance tradeoff" onRespond={props.onNudge} onShown={onRecapShown} />}
          {props.receipt && <ReceiptLine receipt={props.receipt} />}
          {props.note && <StateNote state={{ kind: "needs-retry", detail: props.note }} />}
          {/* Open app sits above the fold of the 420px panel; capture follows. Stopping is never the lesser choice. */}
          <div className="actions equal">
            <button type="button" className="primary" ref={first} onClick={props.onOpenApp}>
              Open app
            </button>
            <button type="button" className="secondary" onClick={props.onStop}>
              Stop for now
            </button>
          </div>
          <HelperCards runs={props.helpers} actions={props.helperActions} compact />
          {props.recap && (
            <section className="panel-recap" aria-labelledby="recap-h">
              <h2 id="recap-h" className="block-title">
                Evening recap
              </h2>
              {props.recap.items.length === 0 ? (
                <p className="quiet small">Nothing finished or parked today.</p>
              ) : (
                <ul className="plain">
                  {props.recap.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
        {/* Capture is its own card beside the context, never glass on glass. */}
        {composer}
        </>
      )}
    </main>
  );
}

/** How many meetings and real due dates fall today, the next one still ahead, and the one recommended start (unless it is the step above). */
function TodayLines({ today, now, step }: { today: { hard: HardItem[]; start?: string }; now: number; step?: string }) {
  const day = new Date(now);
  const todays = today.hard.filter((h) => sameDay(new Date(h.dueAt), day)).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const next = todays.find((h) => Date.parse(h.dueAt) >= now);
  const n = todays.length;
  return (
    <>
      <p>
        {n === 0 ? "No meetings or due dates today." : `${n} ${n === 1 ? "meeting or due date" : "meetings and due dates"} today.`}
        {next && ` Next: ${next.text} at ${clock.format(new Date(next.dueAt))}.`}
      </p>
      {today.start && today.start !== step && (
        <p className="panel-next">
          <span className="why">Start with:</span> {today.start}
        </p>
      )}
    </>
  );
}

/** The last instructed action, honestly: unknown is never shown as sent or as failed. */
function ReceiptLine({ receipt }: { receipt: Receipt }) {
  const sent = receipt.kind !== "update-note"; // an email or a Slack post
  const where = `${sent ? "to " : ""}${receipt.destination}`;
  const state: Honest =
    receipt.state === "succeeded"
      ? { kind: "done", detail: `${sent ? "Sent" : "Updated"} ${where}, verified.${receipt.logState === "failed" ? " Outcome log not written yet." : ""}` }
      : receipt.state === "failed"
        ? { kind: "needs-retry", detail: `Not ${sent ? "sent" : "updated"}. Your draft is kept.` }
        : receipt.state === "unknown"
          ? { kind: "unknown", detail: `We could not confirm this was ${sent ? "sent" : "updated"}. Nothing has been repeated. Check again in the app.` }
          : { kind: "loading", detail: `${sent ? "Sending" : "Updating"} ${where}. Waiting for the provider to confirm it.` };
  return <StateNote state={state} />;
}
