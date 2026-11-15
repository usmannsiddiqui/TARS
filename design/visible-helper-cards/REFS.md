# References

Mobbin was not connected; free sources only. Screenshots live in `refs/` (git-ignored: not ours to ship).

### Ref 1 (primary for visual language): TARS's own design system
Source: `apps/desktop/src/renderer/styles.css`, `screens.css`, `NudgeCard`, `StateTag`, `SourceChip`, `.panel-card`.
Why: the look is decided and not open. Every element in the card already exists here.

Take
- Card: `.block` frosted glass, 14px radius, glass edge + 8/24 shadow; inside the panel's glass an `.inner` surface
  (8px radius), never glass on glass.
- Title: 17px / 700 / -0.01em, `--ink` (the `.block-title` treatment). Compact: 15px.
- State: `StateTag`, 14px glyph + one word at 13px, 0.78 opacity; problems on the black plate (`.state-note` rule).
- Sources: `.source-chip`, the provider mark and its name, 14px / 500 on `--glass-solid` (13px compact).
- Buttons: `.secondary` pill at the row size (34px) and `.text-button` underlined, as NudgeCard and TradeoffFlag.
- Motion tokens: `--ease-out` (0.23, 1, 0.32, 1), `--ease-in-out`; the typing cursor's 500 ms blink in `Typed`.
- Reduced motion: the global rule stops every animation; meaning must survive without it.

Words (TARS's own patterns)
- States are one word: Working (as the pet), Needs retry.
- Failure: the existing sentence "The last preparation failed; the earlier version is kept." (ProjectView).
- Buttons are a verb: "Try preparing again" exists in ProjectView; on a card the shorter "Try again", plus "Dismiss".

Leave
- Nothing from outside references' colour, type or radius.

### Ref 2: Vercel AI Elements, Task component
Source: https://ai-sdk.dev/elements/components/task · saved as `refs/task/default-1280x900-light.png`
Why: same moment, an agent reading sources while it works, shown with the real file names as chips.

Take (structure and words only)
- One line per step: a present-participle verb, then the object, then the item as a chip ("Read [page.tsx]",
  "Scanning 52 files"). Counts as plain numbers inside the sentence.
- Chips are the evidence of reading; they sit right under or inside the step line.
Leave: the collapsible tree, the left rule, the blue tab chrome.

### Ref 3: Vercel AI Elements, Chain of Thought
Source: https://ai-sdk.dev/elements/components/chain-of-thought · `refs/cot/default-1280x900-light.png`
Take: the sources row under the step that read them ("Searching for profiles…" then domain chips); the active step in
the darker ink, finished ones quieter. Leave: icons per step, the image card, the expand control.

### Ref 4: Vercel AI Elements, Queue
Source: https://ai-sdk.dev/elements/components/queue · `refs/queue/default-1280x900-light.png`
Take: several pieces of work listed as equal rows, each with a small status mark before its label, count words
("7 Queued"). Confirms "one card per job, stacked" as the many-at-once pattern. Leave: the circular indicators,
sections, strikethrough.

### Patterns from the skill's agent UI notes (behaviour, not visuals)
- "Present participle + object + progress"; past tense is not needed because a finished card leaves.
- A live timer or a determinate bar only when honest: we know the stage but not the duration, so neither is shown.
- Status lines in `aria-live="polite"`, announcing step changes, not ticks.
