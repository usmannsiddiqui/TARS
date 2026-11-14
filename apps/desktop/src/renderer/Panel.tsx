// The compact panel the pet opens. Presentational: data and actions arrive as props.
import { useEffect, useRef } from "react";
import type { Honest, PetState } from "./model";
import { PET_LABEL, PetFigure, StateNote } from "./ui";

export type PanelProps = {
  petState: PetState;
  projectName?: string;
  /** What is prepared there, in one line of context. */
  context?: string;
  /** The one next action for the current context. */
  nextAction?: string;
  state?: Honest;
  completion?: { done: string; next?: string };
  onOpenApp(): void;
  onStop(): void;
  onClose(): void;
};

/** Current context, one next action and "Open app". Escape closes it. */
export function Panel(props: PanelProps) {
  const first = useRef<HTMLButtonElement>(null);
  const { onClose } = props;
  useEffect(() => {
    first.current?.focus();
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
