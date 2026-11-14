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

// The companion T-01: an original articulated monolith of flat steel planes. Each slab is drawn once at
// rest and posed by a transform, so a state change glides between poses (CSS transition on the group)
// instead of redrawing. Coordinates are a 104x96 field; every pose stays inside it.
type Slab = { x: number; y: number; w: number; h: number; tone: "body" | "fin" };
const SLABS = {
  footing: { x: 40, y: 88, w: 22, h: 5, tone: "body" },
  plinth: { x: 37, y: 77, w: 28, h: 11, tone: "body" },
  core: { x: 40, y: 40, w: 22, h: 37, tone: "body" },
  head: { x: 39, y: 22, w: 24, h: 16, tone: "body" },
  crown: { x: 43, y: 15, w: 16, h: 5, tone: "body" },
  finL: { x: 33, y: 41, w: 4, h: 32, tone: "fin" },
  finR: { x: 65, y: 41, w: 4, h: 32, tone: "fin" },
} satisfies Record<string, Slab>;
type Part = keyof typeof SLABS;

// Pose = a transform per moving part. Idle stands upright; working slides the head over and swings
// one fin out level (a tool arm); done lifts the crown clear and raises both fins.
const POSE: Record<PetState, Partial<Record<Part, string>>> = {
  idle: {},
  working: { head: "translate(4px, 1px)", crown: "translate(4px, 1px)", finR: "rotate(-90deg)" },
  done: { crown: "translate(0, -8px)", finL: "rotate(180deg)", finR: "rotate(180deg)" },
};
// Plane tones: lit top, front, shaded side, and a thin rim where the light catches the left edge.
// Fins are flat blades (no extrusion) so they stay correctly lit at any swing angle.
const TONE = { top: "#8C939E", front: "#4E545E", side: "#2B2F36", fin: "#5A616C", finEdge: "#2B2F36" };
const RIM = "#B9C0CA";
const D = [3, -2.5] as const; // the depth of every body slab, drawn as an oblique extrusion up and right

function SlabShape({ part }: { part: Part }) {
  const { x, y, w, h, tone } = SLABS[part];
  const [dx, dy] = D;
  if (tone === "fin")
    return (
      <>
        <rect x={x} y={y} width={w} height={h} rx="0.6" fill={TONE.fin} />
        <rect x={x + w - 1.2} y={y} width="1.2" height={h} fill={TONE.finEdge} />
        <rect x={x} y={y} width="0.8" height={h} fill={RIM} opacity=".7" />
      </>
    );
  return (
    <>
      <polygon points={`${x},${y} ${x + dx},${y + dy} ${x + w + dx},${y + dy} ${x + w},${y}`} fill={TONE.top} />
      <polygon points={`${x + w},${y} ${x + w + dx},${y + dy} ${x + w + dx},${y + h + dy} ${x + w},${y + h}`} fill={TONE.side} />
      <rect x={x} y={y} width={w} height={h} fill={TONE.front} />
      <rect x={x} y={y} width="0.8" height={h} fill={RIM} opacity=".7" />
    </>
  );
}

/**
 * The pet figure on transparency. `variant` only sets its size and place (pet window, rail/panel mark,
 * the Today hero). States differ by pose and by the display marks, never by colour or motion alone.
 */
export function PetFigure({ state, variant = "tile", className }: { state: PetState; variant?: "tile" | "mark" | "hero"; className?: string }) {
  const pose = POSE[state];
  const part = (name: Part, children?: ReactNode) => {
    const { x, y, w } = SLABS[name];
    // Fins swing from the shoulder; everything else moves as a whole.
    const origin = name.startsWith("fin") ? `${x + w / 2}px ${y}px` : undefined;
    return (
      <g className="pet-part" style={{ transform: pose[name] ?? "none", ...(origin ? { transformOrigin: origin } : {}) }}>
        <SlabShape part={name} />
        {children}
      </g>
    );
  };
  return (
    <svg className={["pet-figure", className].filter(Boolean).join(" ")} data-state={state} data-variant={variant} viewBox="2 2 100 94" aria-hidden="true">
      {part("footing")}
      {part("plinth")}
      {part("core", <path d="M43 50h16M43 55h16" stroke="#3A3F47" strokeWidth="0.8" />)}
      {part(
        "head",
        <>
          <rect x="42" y="26.5" width="18" height="7" rx="1" fill="#07080B" />
          <g className="pet-mark" fill="#FFB547" stroke="#FFB547">
            {state === "idle" && <path d="M45 30h12" strokeWidth="1.4" />}
            {state === "working" && (
              <>
                <rect x="45" y="28.75" width="2.5" height="2.5" stroke="none" />
                <rect x="49.75" y="28.75" width="2.5" height="2.5" stroke="none" />
                <rect className="pet-tick" x="54.5" y="28.75" width="2.5" height="2.5" stroke="none" />
              </>
            )}
            {state === "done" && <path d="M47.5 30 50.2 32.2 55 27.9" fill="none" strokeWidth="1.4" />}
          </g>
        </>,
      )}
      {part("crown")}
      {part("finL")}
      {part("finR")}
    </svg>
  );
}
