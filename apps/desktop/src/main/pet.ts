// The desktop pet's pure rules: where the pet and its panel may sit, when a press is a drag, and when
// the hover panel opens and closes. No Electron here; index.ts applies the results to real windows.

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Rect = Point & Size;

/** A press that travels less than this (CSS px) is a click, not a drag. */
export const DRAG_THRESHOLD_PX = 4;
export const isDrag = (dx: number, dy: number) => Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX;

/** Resting this long on the pet opens the panel; leaving both for this long closes it again. */
export const HOVER_INTENT_MS = 300;
export const HOVER_CLOSE_MS = 400;
/** The pet window: the figure on top (its spot stays put when the window grows), the control pill and its note below. */
export const PET_FIGURE: Size = { width: 184, height: 136 };
export const PET_WINDOW: Size = { width: 184, height: 212 };
/** Gap between the pet and the panel beside it. */
const GAP = 8;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
const contains = (area: Rect, p: Point) => p.x >= area.x && p.x < area.x + area.width && p.y >= area.y && p.y < area.y + area.height;
const centre = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const distance = (area: Rect, p: Point) => Math.hypot(p.x - clamp(p.x, area.x, area.x + area.width), p.y - clamp(p.y, area.y, area.y + area.height));

/**
 * Where a window of this rect may sit: wholly inside the work area that holds its centre, or the
 * nearest one when its centre is on none. Never off every display.
 */
export function clampToWorkAreas(rect: Rect, areas: Rect[]): Point {
  const c = centre(rect);
  const area = areas.find((a) => contains(a, c)) ?? [...areas].sort((a, b) => distance(a, c) - distance(b, c))[0];
  if (!area) return { x: rect.x, y: rect.y };
  return {
    x: Math.round(clamp(rect.x, area.x, area.x + area.width - rect.width)),
    y: Math.round(clamp(rect.y, area.y, area.y + area.height - rect.height)),
  };
}

/** The saved position when its centre is still on a connected display (then held inside it); otherwise null. */
export function restorePetPosition(saved: Point | undefined, size: Size, areas: Rect[]): Point | null {
  if (!saved) return null;
  const rect = { ...saved, ...size };
  return areas.some((a) => contains(a, centre(rect))) ? clampToWorkAreas(rect, areas) : null;
}

/** The panel beside the pet, on whichever side has room (left first), bottoms aligned, inside the work area. */
export function panelBeside(pet: Rect, panel: Size, area: Rect): Point {
  const left = pet.x - GAP - panel.width;
  const x = left >= area.x ? left : pet.x + pet.width + GAP;
  return clampToWorkAreas({ x, y: pet.y + pet.height - panel.height, ...panel }, [area]);
}

/** Whether a screen point is over the figure part of a pet window at `win` (the pill below is not). */
export const overFigure = (win: Point, p: Point) => contains({ x: win.x, y: win.y, ...PET_FIGURE }, p);

/** Where the eyes look: from the box's centre toward the pointer, each axis held within -1..1. */
export function gaze(p: Point, box: Rect): Point {
  const axis = (v: number, start: number, size: number) => clamp((v - start - size / 2) / (size / 2), -1, 1) + 0; // + 0: no -0
  return { x: axis(p.x, box.x, box.width), y: axis(p.y, box.y, box.height) };
}

/**
 * The panel's hover state. "intent" and "closing" wait for a timer; "pinned" (a click, a key, the
 * shortcut or focus inside the panel) ignores the pointer until something closes it. While the button
 * is down on the figure nothing opens and a hover-opened panel closes; after a drag, or a close with
 * the pointer on the pet, the pointer must leave the pet before resting on it opens the panel again.
 */
export type Hover = { mode: "closed" | "intent" | "open" | "closing" | "pinned"; overPet: boolean; overPanel: boolean; suppressed: boolean; pressed: boolean };
export type HoverEvent =
  | { type: "pet" | "panel"; over: boolean }
  | { type: "press" | "pin" | "close" | "timer" }
  /** The button came up; `moved` when the press travelled far enough to be a drag. */
  | { type: "release"; moved: boolean };
export const HOVER_START: Hover = { mode: "closed", overPet: false, overPanel: false, suppressed: false, pressed: false };

export function hoverNext(s: Hover, e: HoverEvent): Hover {
  switch (e.type) {
    case "pin":
      return { ...s, mode: "pinned" };
    case "press":
      return s.mode === "pinned" ? { ...s, pressed: true } : { ...s, mode: "closed", overPanel: false, pressed: true };
    case "release":
      return { ...s, pressed: false, suppressed: s.suppressed || e.moved };
    case "close":
      return { ...s, mode: "closed", overPanel: false, suppressed: s.overPet };
    case "timer":
      if (s.mode === "intent") return { ...s, mode: "open" };
      if (s.mode === "closing") return { ...s, mode: "closed", overPanel: false };
      return s;
    case "pet":
    case "panel": {
      const next = e.type === "pet" ? { ...s, overPet: e.over, suppressed: e.over && s.suppressed } : { ...s, overPanel: e.over };
      const over = next.overPet || next.overPanel;
      if (next.mode === "closed" && next.overPet && !next.suppressed && !next.pressed) return { ...next, mode: "intent" };
      if (next.mode === "intent" && !next.overPet) return { ...next, mode: "closed" };
      if (next.mode === "open" && !over) return { ...next, mode: "closing" };
      if (next.mode === "closing" && over) return { ...next, mode: "open" };
      return next;
    }
  }
}
