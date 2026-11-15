# Spec: helper cards

Tags: [P] primary (TARS design system), [R2] AI Elements Task, [R3] Chain of Thought, [R4] Queue, [DS] TARS tokens,
[B] brief, [C] skill craft default.

## Tokens
- Card: `.block` glass, radius 14, padding 14/18/16 (tighter than a content block, it is a status card) [DS]
- Compact card (panel): `.inner`, radius 8, padding 10/12 [DS]
- Title 17/700/-0.01em, compact 15 [DS]; stage line 15/400 `--ink-2`, compact 14 [DS]; state tag 13 [DS]
- Stage track: three 8px squares, 3px apart; done filled `--ink`; now filled `--ink`, blinking to a 1.5px `--ink`
  ring; next a 1.5px `--ink-3` ring [P: dot-matrix + cursor] (signature visual, a departure)
- Gaps: card rows 8 (compact 4); list 12 (compact 8) [DS]
- Motion: open 260 ms `--ease-out`; close 180 ms `--ease-in-out`; words crossfade 200 ms up 3px; chips open 260 ms;
  blink 1 s `steps(1)` [P/C]

## Anatomy
1. Head: project name (one line, ellipsis, full name in `title`) · StateTag (Working / Needs retry)
2. Stage line: track (hidden from assistive tech) + the stage words (`aria-live="polite"`)
3. Sources row (from drafting): one SourceChip per kind, "Gmail 4" [R2/R3]
4. Failed only: Try again (secondary) · Dismiss (text button) [P]

Today: at the top of the main column, above the nudge; auto-fill columns min 320px, aligned to start. Panel: compact
cards inside the context card, after Open app / Stop for now (the actions stay above the 420px fold).

## Content
- Pending: "Starting" · Reading: "Reading this project's sources" · Drafting: "Drafting from 7 items" (sum of
  counts, "1 item") · Saving: "Checking it against your sources, then saving" · Failed: "The last preparation failed;
  the earlier version is kept." [R2 pattern, P wording]
- No percentages, no timers, no names for helpers [B]

## States
| Axis | Decision |
|---|---|
| Amount | none: no section rendered; one; several projects: one card each in the grid; no "+N more" (one per project, bounded by projects) |
| Shape | long project name: one line, ellipsis, `title` shows it; many source kinds: chips wrap; unknown kind: name falls back to the kind |
| Time | instant (empty evidence): card appears then leaves; long model call: stays on Drafting, blinking; never finishes: the action's own timeout ends it failed |
| Outcome | success: card closes its space and leaves; failure: Needs retry on the black plate, Try again / Dismiss; retry error (for example already preparing): a Needs retry note under the buttons |
| Interaction | buttons disabled while their call runs; nothing focuses itself; nothing blocks the rest of the screen |
| Environment | panel width (360): single column, compact; reduced motion: no blink, "now" is a heavy 2.5px ring (shape still differs from done and next) and no enter/leave animation |

## Departures
- The stage track is new (signature visual), built from TARS's own square marks and ink tokens.
- Card padding is tighter than `.block`'s 18/22/22: a status card, not a reading block.
- `audit` flags backdrop blur: TARS's frosted glass is the decided design system.
- `audit` flags 34px vs 26px controls in the failed row: the TARS pairing of a pill and an underlined text button.
