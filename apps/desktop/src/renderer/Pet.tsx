// The desktop pet. Presentational: state and the actions arrive as props.
import { useId, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { isDrag } from "../main/pet";
import type { PetState } from "./model";
import { PET_LABEL, PetFigure } from "./ui";

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const KEY_STEP = 10;
const KEY_STEP_LARGE = 50;

/**
 * The pet window's whole content: one labelled button and TARS standing alone on the transparent window.
 * The state word is on TARS's own dark screen, so it reads over any wallpaper without a backing plate.
 * Press and drag to move it (pointer capture keeps the drag when the pointer outruns the window); a press
 * that barely moves is a click. Arrow keys move it too.
 */
export function Pet({ state, onOpen, onMove }: { state: PetState; onOpen(): void; onMove(dx: number, dy: number): void }) {
  const hint = useId();
  const press = useRef<{ startX: number; startY: number; lastX: number; lastY: number; dragging: boolean } | null>(null);
  const dragged = useRef(false);

  const down = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = { startX: e.screenX, startY: e.screenY, lastX: e.screenX, lastY: e.screenY, dragging: false };
    dragged.current = false;
  };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || (!p.dragging && !isDrag(e.screenX - p.startX, e.screenY - p.startY))) return;
    p.dragging = dragged.current = true;
    // Screen coordinates, not client ones: the window moves under the pointer while it drags.
    const dx = Math.round(e.screenX - p.lastX);
    const dy = Math.round(e.screenY - p.lastY);
    if (dx === 0 && dy === 0) return;
    p.lastX += dx;
    p.lastY += dy;
    onMove(dx, dy);
  };
  const up = () => void (press.current = null);
  const key = (e: KeyboardEvent<HTMLButtonElement>) => {
    const dir = ARROWS[e.key];
    if (!dir) return;
    e.preventDefault();
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    onMove(dir[0] * step, dir[1] * step);
  };

  return (
    <button
      type="button"
      className="pet"
      data-state={state}
      aria-label={`Open companion panel. ${PET_LABEL[state]}.`}
      aria-describedby={hint}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
      // A drag ends in a click event too; only a press that stayed put opens the panel.
      onClick={() => (dragged.current ? void (dragged.current = false) : onOpen())}
    >
      <PetFigure state={state} />
      <span id={hint} hidden>
        Rest the pointer here to see today. Drag to move, or use the arrow keys; hold Shift for bigger steps.
      </span>
    </button>
  );
}
