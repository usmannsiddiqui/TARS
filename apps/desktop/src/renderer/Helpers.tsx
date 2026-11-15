// TARS's helpers: one small card per preparation that is running (or failed), saying what it is really
// doing right now. Helpers only read and prepare; nothing here sends, shares or writes memory, and nothing
// here blocks the rest of the screen. Presentational: runs arrive by subscription, actions as props.
import { useEffect, useState } from "react";
import { SourceChip } from "./logos";
import { helperWords, type HelperRun } from "./model";
import { reason, SOURCE_NAME, StateNote, StateTag } from "./ui";

const STAGES = ["reading", "drafting", "saving"] as const;

export type HelperActions = { onRetry(projectId: string): Promise<void>; onDismiss(projectId: string): Promise<void> };

/** Runs that just finished stay one exit animation longer, so a leaving card closes its space instead of vanishing. */
function useLeaving(runs: HelperRun[]) {
  const [shown, setShown] = useState<(HelperRun & { leaving?: true })[]>(runs);
  useEffect(() => {
    setShown((prev) => {
      const next: (HelperRun & { leaving?: true })[] = runs.map((r) => ({ ...r }));
      prev.forEach((old, i) => {
        if (!runs.some((r) => r.projectId === old.projectId)) next.splice(Math.min(i, next.length), 0, { ...old, leaving: true });
      });
      return next;
    });
  }, [runs]);
  const gone = (projectId: string) => setShown((prev) => prev.filter((r) => !(r.leaving && r.projectId === projectId)));
  return { shown, gone };
}

export function HelperCards({ runs, compact, actions }: { runs: HelperRun[]; compact?: boolean; actions: HelperActions }) {
  const { shown, gone } = useLeaving(runs);
  if (shown.length === 0) return null;
  return (
    <section className={compact ? "helpers compact" : "helpers"} aria-label="TARS is preparing">
      <ul className="helper-list">
        {shown.map((run) => (
          <li key={run.projectId} className="helper-slot" data-leaving={run.leaving ? "" : undefined} onAnimationEnd={(e) => run.leaving && e.target === e.currentTarget && gone(run.projectId)}>
            <HelperCard run={run} compact={compact === true} actions={actions} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function HelperCard({ run, compact, actions }: { run: HelperRun; compact: boolean; actions: HelperActions }) {
  const { state, doing } = helperWords(run);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failed = run.state === "failed";
  const act = (fn: (id: string) => Promise<void>) => async () => {
    setBusy(true);
    setError(null);
    try {
      await fn(run.projectId);
    } catch (err) {
      setError(reason(err));
    } finally {
      setBusy(false);
    }
  };
  const at = run.state === "running" && run.stage ? STAGES.indexOf(run.stage) : -1;
  return (
    <article className={compact ? "helper inner" : "helper block"} data-state={run.state} aria-label={`${run.projectName}: ${doing}`}>
      <header className="helper-head">
        <h3 className="helper-project" title={run.projectName}>
          {run.projectName}
        </h3>
        <StateTag state={state} />
      </header>
      <p className="helper-doing">
        {!failed && (
          <span className="helper-track" aria-hidden="true">
            {STAGES.map((s, i) => (
              <span key={s} className="helper-step" data-step={i < at ? "done" : i === at ? "now" : "next"} />
            ))}
          </span>
        )}
        {/* Keyed by the words: a stage change crossfades in instead of swapping in place. */}
        <span key={doing} className="helper-words" aria-live="polite">
          {doing}
        </span>
      </p>
      {run.sources.length > 0 && (
        <p className="helper-sources">
          {run.sources.map((s) => (
            <SourceChip key={s.kind} kind={s.kind} label={`${SOURCE_NAME[s.kind] ?? s.kind} ${s.count}`} />
          ))}
        </p>
      )}
      {failed && (
        <div className="actions">
          <button type="button" className="secondary" disabled={busy} onClick={act(actions.onRetry)}>
            Try again
          </button>
          <button type="button" className="text-button" disabled={busy} onClick={act(actions.onDismiss)}>
            Dismiss
          </button>
        </div>
      )}
      {error && <StateNote state={{ kind: "needs-retry", detail: error }} />}
    </article>
  );
}
