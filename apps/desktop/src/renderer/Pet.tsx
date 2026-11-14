// The desktop pet. Presentational: state and the click action arrive as props.
import type { PetState } from "./model";
import { PET_LABEL, PetFigure } from "./ui";

/**
 * The pet window's whole content: one labelled button and TARS standing alone on the transparent window.
 * The state word is on TARS's own dark screen, so it reads over any wallpaper without a backing plate.
 */
export function Pet({ state, onOpen }: { state: PetState; onOpen(): void }) {
  return (
    <button type="button" className="pet" data-state={state} onClick={onOpen} aria-label={`Open companion panel. ${PET_LABEL[state]}.`}>
      <PetFigure state={state} />
    </button>
  );
}
