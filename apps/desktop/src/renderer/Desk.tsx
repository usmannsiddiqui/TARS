// TARS at the front desk: the illustrated scene on Today (and behind "Stopped for now"). Decoration only
// (aria-hidden): every fact it draws is also on the screen as text. A value it does not know is not drawn.
// Flat shapes in the grey family; black is the loud tone and the palette's --accent marks only the active light.
// "mini" is the same drawing framed tight on TARS behind the counter: the brand mark at the top of the rail.
import { useEffect, useRef, type ReactNode } from "react";
import type { PetState, RoutineRow } from "./model";
import { PetFigure } from "./ui";

export type DeskProps = {
  state: PetState;
  /** Captured ideas waiting on this Mac: sheets in the in-tray. */
  inTray?: number | undefined;
  /** Work TARS has prepared and is ready to hand over: sheets in the out-tray. */
  outTray?: number | undefined;
  /** A work session is running: the desk's signal light is on. */
  signal: boolean;
  /** "mini": the rail's brand mark, static and cropped to TARS behind the counter. */
  variant?: "scene" | "mini";
};

/**
 * The right pane: TARS at the front desk, a caption of only what the desk draws (ideas in, prepared work
 * out, the session), then the screen's own content (the routines on Today; the draft and open items in a project).
 */
export function DeskPane({ desk, routines, onRoutine, children }: { desk: DeskProps; routines?: RoutineRow[]; onRoutine?(id: RoutineRow["id"]): void; children?: ReactNode }) {
  const caption = [
    desk.inTray !== undefined && `${desk.inTray} ${desk.inTray === 1 ? "idea" : "ideas"} in`,
    desk.outTray !== undefined && `${desk.outTray} ${desk.outTray === 1 ? "draft" : "drafts"} out`,
    desk.signal ? "Working" : desk.state === "done" ? "Done for today" : "Idle",
  ].filter(Boolean);
  return (
    <>
      <figure className="pane-desk">
        <Desk {...desk} />
        <figcaption className="pane-caption num">{caption.join(" · ")}</figcaption>
      </figure>
      {routines && (
        <section className="pane-section" aria-labelledby="routines-h">
          <h3 id="routines-h" className="pane-heading">
            Routines
          </h3>
          <ul className="routines">
            {routines.map((r) => (
              <li key={r.id}>
                <button type="button" className="routine" onClick={() => onRoutine?.(r.id)} disabled={!onRoutine}>
                  <svg className="icon" width="16" height="16" viewBox="0 0 14 14" aria-hidden="true">
                    <circle cx="7" cy="7" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M7 3.8V7l2.2 1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                  <span className="routine-name">{r.name}</span>
                  <span className="routine-when">{r.summary}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {children}
    </>
  );
}

const TONE = { top: "#EDECE8", front: "#C6C5C0", groove: "#B8B7B2", plinth: "#8F8E89", ink: "#161616", back: "#3A3A3A", paper: "#FAF9F6", chrome: "#DAD9D5", chromeHi: "#F1F0ED", off: "#A9A8A3" };
// shortcut: a tray draws at most five sheets, so a long backlog never buries the desk; the count is in the readout.
const SHEETS_DRAWN = 5;

function Tray({ x, label, count }: { x: number; label: string; count: number | undefined }) {
  const sheets = Math.min(count ?? 0, SHEETS_DRAWN);
  return (
    <g>
      <rect x={x + 3} y="146" width="64" height="12" rx="1.5" fill={TONE.back} />
      {Array.from({ length: sheets }, (_, i) => (
        <rect key={i} x={x + 4 + (i % 2 === 0 ? 0 : 1.8)} y={150 - i * 4} width="62" height="3.4" rx="0.5" fill={TONE.paper} />
      ))}
      <rect x={x} y="153" width="70" height="19" rx="3.5" fill={TONE.ink} />
      <text className="desk-label" x={x + 8} y="166.6">
        {label}
      </text>
    </g>
  );
}

const clamp = (v: number) => Math.max(-1, Math.min(1, v));

export function Desk({ state, inTray, outTray, signal, variant = "scene" }: DeskProps) {
  const ref = useRef<SVGSVGElement>(null);

  // The head turns toward the pointer and the eyes follow a little: pointer events set a target, and
  // animation frames ease toward it only until it settles (no loop while nothing moves).
  useEffect(() => {
    const svg = ref.current;
    const head = svg?.querySelector(".pet-head");
    const face = svg?.querySelector(".head-face");
    const side = svg?.querySelector(".head-side");
    const eyes = svg?.querySelector(".head-eyes");
    if (variant === "mini" || !head || !face || !side || !eyes || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const target = { x: 0, y: 0 };
    const now = { x: 0, y: 0 };
    let raf = 0;
    let last = 0;
    const draw = () => {
      const shift = now.x * 3; // the front face slides and the side plane it uncovers widens
      face.setAttribute("transform", `translate(${shift.toFixed(3)} 0)`);
      side.setAttribute("x", (shift > 0 ? -15 : 15 + shift).toFixed(3));
      side.setAttribute("width", Math.abs(shift).toFixed(3));
      eyes.setAttribute("transform", `translate(${(now.x * 2.2).toFixed(3)} ${(now.y * 1.3).toFixed(3)})`);
    };
    const step = (t: number) => {
      const dt = last ? Math.min(0.05, (t - last) / 1000) : 1 / 60;
      last = t;
      const k = 1 - Math.exp(-dt / 0.14); // critically damped ease, about 0.4 s to settle
      now.x += (target.x - now.x) * k;
      now.y += (target.y - now.y) * k;
      draw();
      if (Math.abs(target.x - now.x) + Math.abs(target.y - now.y) > 0.002) raf = requestAnimationFrame(step);
      else raf = last = 0;
    };
    const move = (e: PointerEvent) => {
      const r = head.getBoundingClientRect();
      target.x = clamp((e.clientX - (r.left + r.width / 2)) / (innerWidth * 0.4));
      target.y = clamp((e.clientY - (r.top + r.height / 2)) / (innerHeight * 0.5));
      if (!raf) raf = requestAnimationFrame(step);
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => {
      window.removeEventListener("pointermove", move);
      cancelAnimationFrame(raf);
    };
  }, [variant]);

  return (
    <svg
      ref={ref}
      className={variant === "mini" ? "desk desk-mini" : "desk"}
      viewBox={variant === "mini" ? "129 2 202 230" : "0 0 460 330"}
      aria-hidden="true"
      data-state={state}
      data-signal={signal ? "on" : "off"}
    >
      <ellipse cx="230" cy="307" rx="216" ry="5" fill="#000" fillOpacity="0.08" />
      <PetFigure state={state} variant="hero" box={{ x: 125, y: 6, width: 210, height: 210 }} />

      {/* The lamp, its shade over the in-tray. */}
      <g fill={TONE.ink}>
        <ellipse cx="40" cy="170" rx="18" ry="4.5" />
        <rect x="38" y="114" width="4" height="56" />
        <path d="M40 114 84 90" stroke={TONE.ink} strokeWidth="3.2" strokeLinecap="round" />
        <circle cx="40" cy="114" r="4.2" />
        <g transform="rotate(16 92 98)">
          <path d="M72 98a20 20 0 0 1 40 0Z" />
          <ellipse cx="92" cy="98" rx="20" ry="3" fill={TONE.chromeHi} />
        </g>
      </g>

      <Tray x={59} label="In" count={inTray} />
      <Tray x={332} label="Out" count={outTray} />

      {/* The reception bell. */}
      <g>
        <ellipse cx="422" cy="169" rx="15" ry="3.4" fill={TONE.ink} />
        <path d="M408 168a14 14 0 0 1 28 0Z" fill={TONE.chrome} />
        <path d="M413 163a9.5 9.5 0 0 1 8-6.5" fill="none" stroke={TONE.chromeHi} strokeWidth="2.4" strokeLinecap="round" />
        <rect x="420.6" y="149" width="2.8" height="6" fill={TONE.ink} />
        <circle cx="422" cy="149" r="2.6" fill={TONE.ink} />
      </g>

      {/* The counter: a long rounded slab, two grooves, a nameplate and the signal light. */}
      <rect x="24" y="174" width="412" height="122" rx="16" fill={TONE.front} />
      <rect x="16" y="170" width="428" height="9" rx="4.5" fill={TONE.top} />
      <rect x="24" y="204" width="412" height="2.2" fill={TONE.groove} />
      <rect x="24" y="212" width="412" height="2.2" fill={TONE.groove} />
      <rect x="44" y="294" width="372" height="12" fill={TONE.plinth} />
      <rect x="170" y="238" width="120" height="25" rx="3" fill={TONE.ink} />
      <text className="desk-plate" x="230" y="254.5" textAnchor="middle">
        Front desk
      </text>
      <circle cx="320" cy="250.5" r="8.5" fill={TONE.ink} />
      <circle className="desk-signal" cx="320" cy="250.5" r="5.2" fill={TONE.off} />
    </svg>
  );
}
