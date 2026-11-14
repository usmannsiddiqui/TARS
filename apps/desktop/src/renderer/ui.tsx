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

/** Plain names for source kinds, as the user sees them in Connections. */
export const SOURCE_NAME: Record<string, string> = {
  slack: "Slack",
  gmail: "Gmail",
  notion: "Notion",
  canvas: "Canvas",
  "outlook-mail": "Outlook mail",
  "outlook-calendar": "Outlook calendar",
  obsidian: "Notes folder",
  "claude-code": "Claude Code sessions",
  codex: "Codex sessions",
};

const HONEST_LABEL: Record<Honest["kind"], string> = {
  "not-signed-in": "Not signed in",
  "missing-access": "Missing access",
  "last-checked": "Last checked",
  partial: "Partial",
  "needs-retry": "Needs retry",
  unknown: "Not confirmed",
  stale: "Stale",
  loading: "Loading",
  empty: "Nothing yet",
  done: "Done",
};

/** A 14px glyph per state, so the state reads by shape and words, never by colour alone. */
function Glyph({ kind }: { kind: Honest["kind"] }) {
  const common = { width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": true, className: "glyph" } as const;
  const line = { fill: "none", stroke: "currentColor", strokeWidth: 2 } as const;
  switch (kind) {
    case "done":
      return (
        <svg {...common}>
          <path d="M2.5 7.5 5.6 10.4 11.5 3.6" {...line} strokeLinejoin="miter" />
        </svg>
      );
    case "needs-retry":
      return (
        <svg {...common}>
          <path d="M11.2 7A4.2 4.2 0 1 1 9.6 3.7" {...line} />
          <path d="M8 1.6h4v4Z" fill="currentColor" />
        </svg>
      );
    case "missing-access":
      return (
        <svg {...common}>
          <path d="M7 1.6 12.8 12H1.2Z" {...line} strokeLinejoin="miter" />
          <path d="M7 5.4v3.2M7 9.8v1.2" {...line} />
        </svg>
      );
    case "unknown":
      return (
        <svg {...common}>
          <rect x="2" y="2" width="10" height="10" {...line} strokeDasharray="2.5 2" />
        </svg>
      );
    case "partial":
      return (
        <svg {...common}>
          <rect x="2" y="2" width="10" height="10" {...line} />
          <rect x="2" y="2" width="5" height="10" fill="currentColor" />
        </svg>
      );
    case "stale":
    case "last-checked":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="5.2" {...line} />
          <path d="M7 3.8V7l2.2 1.5" {...line} />
        </svg>
      );
    case "not-signed-in":
      return (
        <svg {...common}>
          <rect x="2.5" y="6" width="9" height="6.5" fill="currentColor" />
          <path d="M4.5 6V4.5a2.5 2.5 0 0 1 5 0V6" {...line} />
        </svg>
      );
    case "loading":
      return (
        <svg {...common}>
          <rect x="1.5" y="5.5" width="3" height="3" fill="currentColor" />
          <rect x="5.5" y="5.5" width="3" height="3" fill="currentColor" />
          <rect x="9.5" y="5.5" width="3" height="3" fill="currentColor" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M2 7h10" {...line} />
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

// The companion T-01: an original slab monolith. One rectangle list per state, [x, y, w, h, fill], in a
// 104x124 field. The long shadows are computed from the same list, so pose and shadow never disagree.
type Slab = readonly [x: number, y: number, w: number, h: number, fill: string];
const C = { bone: "#EDE7DB", concrete: "#BDB5A6", slate: "#6E7381", cobalt: "#2441A6", ink: "#15171D" };
const FIXED: Slab[] = [
  [36, 42, 28, 32, C.bone], // core
  [33, 74, 34, 14, C.cobalt], // plinth
  [37, 88, 26, 6, C.ink], // footing
];
const POSE: Record<PetState, Slab[]> = {
  idle: [[40, 14, 20, 8, C.bone], [36, 22, 28, 20, C.concrete], [30, 44, 6, 28, C.slate], [64, 44, 6, 28, C.slate]],
  // The top of the stack slides over and one fin swings out level.
  working: [[46, 15, 20, 8, C.bone], [41, 23, 28, 19, C.concrete], [30, 44, 6, 28, C.slate], [64, 50, 24, 6, C.slate]],
  // The crown lifts clear and both fins rise.
  done: [[40, 5, 20, 8, C.bone], [36, 22, 28, 20, C.concrete], [30, 18, 6, 26, C.slate], [64, 18, 6, 26, C.slate]],
};
const longShadow = ([x, y, w, h]: Slab, l: number) => `${x + w},${y} ${x + w + l},${y + l} ${x + w + l},${y + h + l} ${x + l},${y + h + l} ${x},${y + h}`;

/**
 * The pet figure. `tile`: the whole amber field (pet window). `mark`: the field cropped to the figure
 * (rail, panel). `hero`: the figure alone, its shadows running far past the box so an amber slab
 * around it crops them. States differ by pose and by the face marks, never by colour or motion alone.
 */
export function PetFigure({ state, variant = "tile", className }: { state: PetState; variant?: "tile" | "mark" | "hero"; className?: string }) {
  const slabs = [...POSE[state].slice(0, 2), ...FIXED, ...POSE[state].slice(2)];
  const reach = variant === "hero" ? 640 : 90;
  const shift = state === "working" ? 5 : 0;
  return (
    <svg
      key={state} // a pose change remounts, so the hard-cut snap replays
      className={["pet-figure", className].filter(Boolean).join(" ")}
      data-state={state}
      data-variant={variant}
      viewBox={variant === "tile" ? "0 0 104 124" : "22 2 56 94"}
      aria-hidden="true"
    >
      {variant !== "hero" && <rect x="0" y="0" width="104" height="124" fill="#F3A712" />}
      <g fill="#8A520A">
        {slabs.map((r, i) => (
          <polygon key={i} points={longShadow(r, reach)} />
        ))}
      </g>
      {slabs.map(([x, y, w, h, fill], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} fill={fill} stroke={C.ink} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      ))}
      <path d="M41 58h23M41 66h23M36 81h31" stroke={C.ink} strokeOpacity=".35" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      <rect x={39 + shift} y={state === "working" ? 29 : 28} width="22" height="8" fill={C.ink} />
      <g className="pet-mark" fill="#AFC0EA" stroke="#AFC0EA">
        {state === "idle" && <path d="M42 32h6M52 32h6" strokeWidth="2" />}
        {state === "working" && (
          <>
            <rect x="46" y="31" width="4" height="4" stroke="none" />
            <rect x="52" y="31" width="4" height="4" stroke="none" />
            <rect className="pet-tick" x="58" y="31" width="4" height="4" stroke="none" />
          </>
        )}
        {state === "done" && <path d="M44.5 32 48.2 34.8 55.5 29.6" fill="none" strokeWidth="2" />}
      </g>
    </svg>
  );
}
