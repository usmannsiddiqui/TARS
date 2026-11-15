// Small shared presentational pieces: honest state notes, the pet figure and formatting.
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import type { Honest, NudgeChoice, NudgeOffer, PetState } from "./model";

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
  teams: "Microsoft Teams",
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
  scheduled: "Scheduled",
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
    case "scheduled":
      return (
        <svg {...common}>
          <rect x="1.8" y="2.8" width="10.4" height="9.4" {...line} strokeWidth={1.6} />
          <path d="M1.8 5.8h10.4M4.6 1.2v3M9.4 1.2v3" {...line} strokeWidth={1.6} />
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

/** A state as its glyph and one word, for a compact place such as a pill; the detail lives elsewhere. */
export function StateTag({ state, id }: { state: Honest; id?: string }) {
  return (
    <span className="state-tag" data-kind={state.kind} id={id}>
      <Glyph kind={state.kind} />
      {HONEST_LABEL[state.kind]}
    </span>
  );
}

/** One nudge for a due commitment: open its draft together, or not now (it comes back gently, later). */
export function NudgeCard({ offer, className, onRespond, onShown }: { offer: NudgeOffer; className: string; onRespond(choice: NudgeChoice): Promise<void>; onShown(key: string): void }) {
  const id = useId();
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });
  // Shown here, so it is not also raised as a notification.
  useEffect(() => {
    if (!offer.delivered) onShown(offer.key);
  }, [offer.key, offer.delivered, onShown]);
  const respond = async (choice: NudgeChoice) => {
    setState({ busy: true });
    try {
      await onRespond(choice);
      setState({ busy: false });
    } catch (err) {
      setState({ busy: false, error: reason(err) });
    }
  };
  return (
    <section className={className} aria-labelledby={id}>
      <h2 id={id} className="block-title">
        {offer.title}
      </h2>
      <StateNote state={{ kind: "partial", detail: "A draft is waiting in the project" }} />
      <p>{offer.body}</p>
      <div className="actions">
        <button type="button" className="primary" disabled={state.busy} onClick={() => respond("finish")}>
          Finish it together
        </button>
        <button type="button" className="secondary" disabled={state.busy} onClick={() => respond("not-now")}>
          Not now
        </button>
      </div>
      {state.error && <StateNote state={{ kind: "needs-retry", detail: state.error }} />}
    </section>
  );
}

export const PET_LABEL: Record<PetState, string> = { idle: "Idle", working: "Working", done: "Done" };

// TARS, drawn from the owner's photo: four tall brushed-aluminium slabs side by side, a small dark
// screen set across the two inner slabs with two soft oval eyes, black "TARS" running up the lower
// centre with a dot-matrix beside it. Each outer slab is drawn once at rest and posed by a transform, so
// a state change glides between poses (CSS transition on the group). Units: slabs are 15 x 62, centred
// on x = 0.
const SLAB_X = { s1: -31.5, s2: -15.5, s3: 0.5, s4: 16.5 } as const;
type Slab = keyof typeof SLAB_X;
const W = 15;
const H = 62;

// Idle: a closed monolith. Working: mid-stride, one outer slab lifted back, the other planted forward.
// Done: both outer slabs swung open into a V, as in the photo. Each pose differs in silhouette alone.
const POSE: Record<PetState, Partial<Record<Slab, string>>> = {
  idle: {},
  working: { s1: "translate(0px, -7px) rotate(-3deg)", s4: "translate(0px, 2px) scale(1.04)" },
  done: { s1: "rotate(-14deg)", s4: "rotate(14deg)" },
};
// Flat aluminium planes: a lit left edge, the body, a brushed mid band, a shaded right band and edge.
const AL = { lit: "#CDD0D0", body: "#B4B8BA", brush: "#ABAFB2", streak: "#C2C5C7", shade: "#989DA0", edge: "#73787B", cap: "#DADCDC", foot: "#6F7477", rivet: "#858A8D" };
const LETTER_INK = "#18191A";
const EYE = "#E7E5EF"; // pale lilac-white, flat: eyes, never a light

function SlabShape({ x }: { x: number }) {
  return (
    <>
      <rect x={x} y="0" width={W} height={H} fill={AL.body} />
      <rect x={x} y="0" width="2" height={H} fill={AL.lit} />
      <rect x={x + 6} y="0" width="3" height={H} fill={AL.brush} />
      <rect x={x + 4.5} y="0" width="0.3" height={H} fill={AL.streak} />
      <rect x={x + 10.5} y="0" width="0.3" height={H} fill={AL.streak} />
      <rect x={x + 12} y="0" width="2.2" height={H} fill={AL.shade} />
      <rect x={x + 14.2} y="0" width="0.8" height={H} fill={AL.edge} />
      <rect x={x} y="0" width={W} height="1.4" fill={AL.cap} />
      <rect x={x} y={H - 1.2} width={W} height="1.2" fill={AL.foot} />
      <g fill={AL.rivet}>
        <circle cx={x + 2.4} cy="3.4" r="0.55" />
        <circle cx={x + 12.6} cy="3.4" r="0.55" />
        <circle cx={x + 2.4} cy={H - 3.4} r="0.55" />
        <circle cx={x + 12.6} cy={H - 3.4} r="0.55" />
      </g>
    </>
  );
}

// Braille-like dot-matrix beside the lettering: [column, row] in a 2 x 6 grid.
const DOTS = [
  [0, 0], [1, 0], [0, 1], [1, 2], [0, 3], [1, 3], [0, 4], [1, 5],
] as const;

/**
 * The face on TARS's screen, one mark group per state so it reads by shape: idle, two soft ovals that
 * blink; working, the eyes narrowed in concentration beside the accent-coloured active light; done, two
 * closed happy arcs. `small` leaves room under the eyes for the pet's state word.
 */
function Face({ state, small }: { state: PetState; small: boolean }) {
  const y = small ? 7.7 : 11;
  const dx = small ? 4.6 : 5.6;
  const rx = small ? 1.6 : 2.3;
  const ry = small ? 1.95 : 3.1;
  return (
    <g className="pet-mark">
      {state === "idle" && (
        <g className="pet-eyes" fill={EYE}>
          <ellipse cx={-dx} cy={y} rx={rx} ry={ry} />
          <ellipse cx={dx} cy={y} rx={rx} ry={ry} />
        </g>
      )}
      {state === "working" && (
        <>
          <ellipse cx={-dx} cy={y + ry * 0.35} rx={rx * 1.05} ry={ry * 0.5} fill={EYE} />
          <ellipse cx={dx} cy={y + ry * 0.35} rx={rx * 1.05} ry={ry * 0.5} fill={EYE} />
          <circle className="pet-tick" cx="11.4" cy="6.4" r={small ? 1 : 1.2} />
        </>
      )}
      {state === "done" && (
        <path
          d={`M${-dx - rx} ${y + 0.6}Q${-dx} ${y - ry * 1.2} ${-dx + rx} ${y + 0.6}M${dx - rx} ${y + 0.6}Q${dx} ${y - ry * 1.2} ${dx + rx} ${y + 0.6}`}
          fill="none"
          stroke={EYE}
          strokeWidth={small ? 1.1 : 1.4}
          strokeLinecap="round"
        />
      )}
    </g>
  );
}

/**
 * TARS on transparency. `variant` sets its frame: "tile" is the pet window (room for every pose, and the
 * state word on its own screen as real text); "mark" and "hero" are framed tight on the figure. States
 * differ by pose and by the face, never by colour or motion alone. The screen sits in `.pet-head`, whose
 * `.head-face` and `.head-side` the desk scene moves to turn the head; `box` places the figure inside
 * another SVG.
 */
export function PetFigure({
  state,
  variant = "tile",
  className,
  box,
}: {
  state: PetState;
  variant?: "tile" | "mark" | "hero";
  className?: string;
  box?: { x: number; y: number; width: number; height: number };
}) {
  const pose = POSE[state];
  const tile = variant === "tile";
  // Behind the front desk the counter hides the lower body, so the lettering sits higher there.
  const lift = variant === "hero" ? 13 : 0;
  const slab = (name: Slab) => {
    const x = SLAB_X[name];
    const posed = name === "s1" || name === "s4";
    return (
      <g className={posed ? "pet-part" : undefined} style={posed ? { transform: pose[name] ?? "none", transformOrigin: `${x + W / 2}px ${H}px` } : undefined}>
        {posed ? (
          // The hover "hello" moves this inner group, so it adds to the pose instead of replacing it.
          <g className="pet-wave" data-side={name === "s1" ? "l" : "r"} style={{ transformOrigin: `${x + W / 2}px ${H}px` }}>
            <SlabShape x={x} />
          </g>
        ) : (
          <SlabShape x={x} />
        )}
      </g>
    );
  };
  return (
    <svg
      className={["pet-figure", className].filter(Boolean).join(" ")}
      data-state={state}
      data-variant={variant}
      viewBox={tile ? "-50 -8 100 73" : "-33 -2 66 66"}
      overflow="visible"
      aria-hidden="true"
      {...box}
    >
      <rect x="-17" y="1" width="34" height={H - 2} fill="#2F3335" />
      {slab("s1")}
      {slab("s2")}
      {slab("s3")}
      {slab("s4")}
      <g className="pet-head">
        <rect className="head-side" x="-15" y="3" width="0" height="16" fill="#3E4244" />
        <g className="head-face">
          <rect x="-15" y="3" width="30" height="16" fill="#1D2122" />
          <rect x="-14" y="4" width="28" height="14" fill="#0B0C0D" />
          <g className="head-eyes">
            <Face state={state} small={tile} />
          </g>
          {tile && (
            <text className="pet-word" x="0" y="16.4" textAnchor="middle">
              {PET_LABEL[state]}
            </text>
          )}
        </g>
      </g>
      <text className="pet-letters" transform={`translate(-6.2 ${57 - lift}) rotate(-90)`} fill={LETTER_INK}>
        TARS
      </text>
      <g fill={LETTER_INK}>
        {DOTS.map(([c, r]) => (
          <circle key={`${c}${r}`} cx={3.4 + c * 2.8} cy={36 - lift + r * 3.4} r="0.95" />
        ))}
      </g>
    </svg>
  );
}

/** One project name and Add. "Add a project" on the project index; "Project name" when it is the first. */
export function NewProject({ onCreate, compact }: { onCreate(name: string): Promise<void>; compact?: boolean }) {
  const id = useId();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onCreate(name);
      setName("");
    } catch (err) {
      setError(reason(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className={compact ? "new-project compact" : "new-project"} onSubmit={submit}>
      <label htmlFor={id}>{compact ? "Add a project" : "Project name"}</label>
      <div className="inline-field">
        <input id={id} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="secondary" disabled={busy || name.trim() === ""}>
          Add
        </button>
      </div>
      {error && <p role="alert" className="field-error">{error}</p>}
    </form>
  );
}
