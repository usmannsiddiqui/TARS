// The desktop pet's pure rules: where it may sit, when a press is a drag, and when the hover panel opens and closes.
import { describe, expect, it } from "vitest";
import { clampToWorkAreas, gaze, HOVER_START, hoverNext, isDrag, overFigure, panelBeside, PET_WINDOW, restorePetPosition, type Hover, type HoverEvent } from "../../apps/desktop/src/main/pet";

const laptop = { x: 0, y: 25, width: 1440, height: 875 };
// A second display to the right, taller, with its top higher than the laptop's.
const monitor = { x: 1440, y: -300, width: 1920, height: 1150 };
const pet = { width: 184, height: 136 };

describe("clampToWorkAreas", () => {
  it("pet_inside_a_work_area_stays_where_it_was_dropped", () => {
    expect(clampToWorkAreas({ x: 300, y: 400, ...pet }, [laptop, monitor])).toEqual({ x: 300, y: 400 });
  });

  it("pet_dragged_past_an_edge_is_held_inside_that_display", () => {
    expect(clampToWorkAreas({ x: -500, y: 2000, ...pet }, [laptop])).toEqual({ x: 0, y: 25 + 875 - 136 });
    // Under the menu bar is not a work area.
    expect(clampToWorkAreas({ x: 100, y: 0, ...pet }, [laptop])).toEqual({ x: 100, y: 25 });
  });

  it("pet_off_every_display_comes_back_to_the_nearest_one", () => {
    expect(clampToWorkAreas({ x: 9000, y: 0, ...pet }, [laptop, monitor])).toEqual({ x: 1440 + 1920 - 184, y: 0 });
  });

  it("pet_straddling_two_displays_settles_on_the_one_holding_its_centre", () => {
    // Centre at x = 1400 + 92 = 1492: on the monitor.
    expect(clampToWorkAreas({ x: 1400, y: 100, ...pet }, [laptop, monitor])).toEqual({ x: 1440, y: 100 });
  });
});

describe("restorePetPosition", () => {
  it("restores_a_saved_position_on_a_connected_display", () => {
    expect(restorePetPosition({ x: 2000, y: -200 }, pet, [laptop, monitor])).toEqual({ x: 2000, y: -200 });
  });

  it("drops_a_saved_position_whose_display_is_gone", () => {
    expect(restorePetPosition({ x: 2000, y: -200 }, pet, [laptop])).toBeNull();
    expect(restorePetPosition(undefined, pet, [laptop])).toBeNull();
  });
});

describe("isDrag", () => {
  it("press_moving_under_four_pixels_is_a_click", () => {
    expect(isDrag(0, 0)).toBe(false);
    expect(isDrag(3, 0)).toBe(false);
    expect(isDrag(2, 2)).toBe(false);
  });

  it("press_moving_four_pixels_or_more_is_a_drag", () => {
    expect(isDrag(4, 0)).toBe(true);
    expect(isDrag(0, -4)).toBe(true);
    expect(isDrag(3, 3)).toBe(true);
  });
});

describe("panelBeside", () => {
  const panel = { width: 360, height: 420 };

  it("opens_on_the_left_of_a_pet_in_the_right_corner_bottoms_aligned", () => {
    const at = { x: 1440 - 184 - 24, y: 900 - 136 - 24, ...pet };
    expect(panelBeside(at, panel, laptop)).toEqual({ x: at.x - 8 - 360, y: at.y + 136 - 420 });
  });

  it("opens_on_the_right_when_the_left_has_no_room", () => {
    const at = { x: 10, y: 400, ...pet };
    expect(panelBeside(at, panel, laptop)).toEqual({ x: 10 + 184 + 8, y: 400 + 136 - 420 });
  });

  it("stays_inside_the_work_area_near_the_top", () => {
    const at = { x: 800, y: 25, ...pet };
    expect(panelBeside(at, panel, laptop)).toEqual({ x: 800 - 8 - 360, y: 25 });
  });
});

describe("hoverNext", () => {
  const run = (...events: HoverEvent[]) => events.reduce<Hover>(hoverNext, HOVER_START);
  const petIn: HoverEvent = { type: "pet", over: true };
  const petOut: HoverEvent = { type: "pet", over: false };
  const panelIn: HoverEvent = { type: "panel", over: true };
  const panelOut: HoverEvent = { type: "panel", over: false };
  const timer: HoverEvent = { type: "timer" };

  it("resting_on_the_pet_waits_for_intent_then_opens", () => {
    expect(run(petIn).mode).toBe("intent");
    expect(run(petIn, timer).mode).toBe("open");
  });

  it("leaving_before_the_intent_fires_opens_nothing", () => {
    expect(run(petIn, petOut).mode).toBe("closed");
    expect(run(petIn, petOut, timer).mode).toBe("closed");
  });

  it("moving_from_the_pet_into_the_panel_keeps_it_open", () => {
    expect(run(petIn, timer, petOut).mode).toBe("closing");
    expect(run(petIn, timer, petOut, panelIn).mode).toBe("open");
    expect(run(petIn, timer, petOut, panelIn, timer).mode).toBe("open");
  });

  it("leaving_both_closes_after_the_grace_delay", () => {
    expect(run(petIn, timer, petOut, panelIn, panelOut).mode).toBe("closing");
    const closed = run(petIn, timer, petOut, panelIn, panelOut, timer);
    expect(closed).toEqual(HOVER_START);
  });

  const press: HoverEvent = { type: "press" };
  const dropped: HoverEvent = { type: "release", moved: true };
  const clicked: HoverEvent = { type: "release", moved: false };

  it("a_press_cancels_intent_and_nothing_opens_while_the_button_is_down", () => {
    expect(run(petIn, press).mode).toBe("closed");
    // The intent timer (armed before the press) firing during the press opens nothing.
    expect(run(petIn, press, timer).mode).toBe("closed");
    // Window moves under the pointer during the drag report leave/enter again: still nothing opens.
    expect(run(petIn, press, petOut, petIn).mode).toBe("closed");
    expect(run(petIn, press, petOut, petIn, timer).mode).toBe("closed");
  });

  it("a_press_after_hover_opened_the_panel_closes_it_at_once", () => {
    expect(run(petIn, timer).mode).toBe("open");
    expect(run(petIn, timer, press).mode).toBe("closed");
    expect(run(petIn, timer, press, timer).mode).toBe("closed");
  });

  it("hold_then_move_then_drop_opens_nothing_until_the_pointer_leaves_and_returns", () => {
    // A pause longer than the intent before moving, then the drop with the pointer still on the pet.
    const afterDrop = run(petIn, press, timer, dropped);
    expect(afterDrop.mode).toBe("closed");
    expect(run(petIn, press, timer, dropped, petIn, timer).mode).toBe("closed");
    expect(run(petIn, press, dropped, petOut, petIn).mode).toBe("intent");
  });

  it("a_press_released_in_place_is_left_to_the_click_which_pins", () => {
    expect(run(petIn, press, clicked).mode).toBe("closed");
    expect(run(petIn, press, clicked, { type: "pin" }).mode).toBe("pinned");
  });

  it("a_press_never_closes_a_pinned_panel", () => {
    expect(run({ type: "pin" }, press).mode).toBe("pinned");
  });

  it("closing_while_the_pointer_is_elsewhere_does_not_block_the_next_hover", () => {
    // Pinned by the shortcut, closed with Escape while the pointer was away: the next rest opens it.
    expect(run({ type: "pin" }, { type: "close" }, petIn).mode).toBe("intent");
    // Closed while resting on the pet: it waits for the pointer to leave first.
    expect(run(petIn, { type: "pin" }, { type: "close" }, petIn, timer).mode).toBe("closed");
  });

  it("pinned_by_click_or_key_ignores_the_pointer_until_closed", () => {
    expect(run({ type: "pin" }).mode).toBe("pinned");
    expect(run(petIn, { type: "pin" }, petOut, timer).mode).toBe("pinned");
    expect(run(petIn, timer, { type: "pin" }, petOut, panelOut, timer).mode).toBe("pinned");
    expect(run({ type: "pin" }, { type: "close" }).mode).toBe("closed");
  });

  it("closing_forgets_the_hidden_panel_so_the_next_hover_can_close_again", () => {
    const reopened = run(petIn, timer, panelIn, { type: "close" }, petOut, petIn, timer);
    expect(reopened.mode).toBe("open");
    expect(hoverNext(reopened, petOut).mode).toBe("closing");
  });
});

describe("overFigure", () => {
  const win = { x: 100, y: 200, ...PET_WINDOW };
  it("the_figure_is_the_top_of_the_pet_window_and_the_pill_below_is_not_part_of_it", () => {
    expect(overFigure(win, { x: 101, y: 201 })).toBe(true);
    expect(overFigure(win, { x: 283, y: 335 })).toBe(true);
    expect(overFigure(win, { x: 190, y: 200 + 136 + 10 })).toBe(false);
    expect(overFigure(win, { x: 99, y: 250 })).toBe(false);
  });
});

describe("gaze", () => {
  const box = { x: 0, y: 0, width: 100, height: 60 };
  it("points_from_the_centre_toward_the_pointer_within_one_unit", () => {
    expect(gaze({ x: 50, y: 30 }, box)).toEqual({ x: 0, y: 0 });
    expect(gaze({ x: 100, y: 0 }, box)).toEqual({ x: 1, y: -1 });
    expect(gaze({ x: 75, y: 45 }, box)).toEqual({ x: 0.5, y: 0.5 });
    expect(gaze({ x: -500, y: 900 }, box)).toEqual({ x: -1, y: 1 });
  });
});
