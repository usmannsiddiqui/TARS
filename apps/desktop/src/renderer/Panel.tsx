// The compact panel the pet opens. Presentational: data and actions arrive as props.
import { useEffect, useRef } from "react";
import { Composer } from "./Composer";
import type { Honest, PetState, Receipt } from "./model";
import { PET_LABEL, PetFigure, StateNote } from "./ui";

export type PanelProps = {
  petState: PetState;
  projectId?: string;
  projectName?: string;
  /** What is prepared there, in one line of context. */
  context?: string;
  /** The one next action for the current context. */
  nextAction?: string;
  state?: Honest;
  completion?: { done: string; next?: string };
  /** Tonight's recap, shown only because the user opened the panel. */
  recap?: { key: string; items: string[]; delivered: boolean };
  /** The recap was actually shown, so it is never offered again. */
  onRecapShown(key: string): void;
  /** The focus project's newest instructed action. */
  receipt?: Receipt;
  note?: string;
  onOpenApp(): void;
  onStop(): void;
  onClose(): void;
};

/** Current context, one next action and "Open app". Escape closes it. */
export function Panel(props: PanelProps) {
  const first = useRef<HTMLButtonElement>(null);
  const { onClose, onRecapShown } = props;
  const recapKey = props.recap && !props.recap.delivered ? props.recap.key : undefined;
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (!recapKey || reported.current === recapKey) return; // one report per showing
    reported.current = recapKey;
    onRecapShown(recapKey);
  }, [recapKey, onRecapShown]);
  useEffect(() => {
    first.current?.focus({ preventScroll: true }); // keep the context at the top in view
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <main className="panel" aria-labelledby="panel-h">
      <header className="panel-head">
        <PetFigure state={props.petState} size={28} />
        <span className="wordmark">Companion</span>
        <span className="panel-state">{PET_LABEL[props.petState]}</span>
        <button type="button" className="text-button" onClick={props.onClose}>
          Close
        </button>
      </header>

      {props.completion ? (
        <section className="panel-body completion" aria-labelledby="panel-h">
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
      ) : (
        <section className="panel-body" aria-labelledby="panel-h">
          <p className="block-title">Now</p>
          <h1 id="panel-h">{props.projectName ?? "No project chosen"}</h1>
          {props.context && <p className="panel-context">{props.context}</p>}
          {props.state && <StateNote state={props.state} />}
          {props.nextAction && (
            <p className="panel-next">
              <span className="why">Next:</span> {props.nextAction}
            </p>
          )}
          {props.receipt && <ReceiptLine receipt={props.receipt} />}
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
          {props.note && <StateNote state={{ kind: "needs-retry", detail: props.note }} />}
          <Composer {...(props.projectId ? { projectId: props.projectId } : {})} />
          <div className="actions stack">
            <button type="button" className="primary" ref={first} onClick={props.onOpenApp}>
              Open app
            </button>
            <button type="button" className="secondary" onClick={props.onStop}>
              Stop for now
            </button>
          </div>
        </section>
      )}
    </main>
  );
}

/** The last instructed action, honestly: unknown is never shown as sent or as failed. */
function ReceiptLine({ receipt }: { receipt: Receipt }) {
  const state: Honest =
    receipt.state === "succeeded"
      ? { kind: "done", detail: receipt.logState === "failed" ? "Verified; outcome log not written yet." : "Verified." }
      : receipt.state === "failed"
        ? { kind: "needs-retry", detail: "Not sent. Your draft is kept." }
        : receipt.state === "unknown"
          ? { kind: "unknown", detail: "We could not confirm this was sent. Nothing has been resent. Check again in the app." }
          : { kind: "loading", detail: "Sending. Waiting for the provider to confirm it." };
  return <StateNote state={state} />;
}
