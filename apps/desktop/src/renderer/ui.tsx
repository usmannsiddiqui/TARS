// Small shared presentational pieces: honest state notes, the pet figure and formatting.
import type { ReactNode } from "react";
import type { Honest, PetState } from "./model";

const time = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
export const formatWhen = (iso: string) => (Number.isNaN(Date.parse(iso)) ? "unknown time" : time.format(Date.parse(iso)));

/** Electron prefixes rejected invoke() errors and Convex wraps server errors; show only the message. */
export const reason = (err: unknown) => {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data: unknown }).data;
    if (typeof data === "string") return data;
    if (data && typeof data === "object" && "reason" in data) return String((data as { reason: unknown }).reason);
  }
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (\w+: )?/, "") : String(err);
};

const HONEST_LABEL: Record<Honest["kind"], string> = {
  "not-signed-in": "Not signed in",
  "missing-access": "Missing access",
  "last-checked": "Last checked",
  partial: "Partial",
  "needs-retry": "Needs retry",
  stale: "Stale",
  loading: "Loading",
  empty: "Nothing yet",
  done: "Done",
};

/** A small glyph per state, so the state reads by shape and words, never by colour alone. */
function Glyph({ kind }: { kind: Honest["kind"] }) {
  const common = { width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": true, className: "glyph" } as const;
  switch (kind) {
    case "done":
      return (
        <svg {...common}>
          <path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "needs-retry":
    case "missing-access":
      return (
        <svg {...common}>
          <path d="M6 1.5 11 10.5H1Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <path d="M6 5v2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case "partial":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M6 1.5a4.5 4.5 0 0 1 0 9Z" fill="currentColor" />
        </svg>
      );
    case "stale":
    case "last-checked":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M6 3.5V6l1.8 1.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case "not-signed-in":
      return (
        <svg {...common}>
          <rect x="2" y="5.5" width="8" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2 2" />
        </svg>
      );
  }
}

/** One honest state in words. Problems (retry, missing access) are visually distinct from Empty and Done. */
export function StateNote({ state, children }: { state: Honest; children?: ReactNode }) {
  const detail =
    state.kind === "last-checked"
      ? formatWhen(state.at)
      : state.kind === "stale" && !state.detail
        ? state.at && `last good ${formatWhen(state.at)}`
        : "detail" in state
          ? state.detail
          : undefined;
  return (
    <p className="state-note" data-kind={state.kind} role={state.kind === "needs-retry" ? "alert" : undefined}>
      <Glyph kind={state.kind} />
      <span className="state-label">{HONEST_LABEL[state.kind]}</span>
      {detail && <span className="state-detail">{detail}</span>}
      {children}
    </p>
  );
}

export const PET_LABEL: Record<PetState, string> = { idle: "Idle", working: "Working", done: "Done" };

/**
 * The companion's figure: an original, abstract pebble. Its three states differ by the mark inside
 * (a resting line, three beats, a lifted chevron) and by the label beside it, never by colour or motion.
 */
export function PetFigure({ state, size = 56 }: { state: PetState; size?: number }) {
  return (
    <svg className="pet-figure" data-state={state} width={size} height={size} viewBox="0 0 56 56" aria-hidden="true">
      <path className="pet-body" d="M28 6c13 0 22 8.5 22 21.5S41.5 50 28 50 6 41 6 27.5 15 6 28 6Z" />
      <g className="pet-mark">
        {state === "idle" && <path d="M20 29h16" />}
        {state === "working" && (
          <>
            <circle cx="20" cy="29" r="2.2" />
            <circle cx="28" cy="29" r="2.2" />
            <circle cx="36" cy="29" r="2.2" />
          </>
        )}
        {state === "done" && <path d="M20 32l8-7 8 7" />}
      </g>
    </svg>
  );
}
