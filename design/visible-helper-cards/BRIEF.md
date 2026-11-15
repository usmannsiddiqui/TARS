# Visible helper cards: brief

**Who.** One entrepreneur with ADHD, on Today in the app window or glancing at the 360x420 panel the pet opens.
They asked TARS to prepare a project (or new mail started an automatic preparation) and they are already doing
something else.

**The moment.** A preparation takes one model call: usually 5 to 40 seconds, sometimes longer. Several projects can
prepare at once. It can fail (provider error, invalid output, a source revoked mid-run). Before this change the only
signs were a "Preparing…" button inside one project and, afterwards, a changed state tag.

**What the system knows** (from the run row, pushed by subscription; nothing else is shown):
- the project's name;
- the run's real state: waiting to start, running, or failed;
- the stage it is really in: reading the project's evidence, drafting (the model call), saving (validating against
  the evidence, then storing with a fresh scope check);
- from drafting on, the source kinds in the evidence sent to the model and how many items each.
It does not know how long the model will take, so no timer estimate, no percentage.

**Success, as behaviour.**
- They keep working instead of waiting on the project page: nothing here blocks input or steals focus.
- At a glance they can tell what TARS is doing for which project, and which sources it drew on, so they trust the
  draft when it lands.
- A failure is noticed and acted on (Try again or Dismiss) rather than discovered later.
- A finished run leaves quietly; the existing prepared-work and "started for you" surfaces carry the result.

**Constraints.**
- TARS's look is decided: light studio grey, black Helvetica Neue Bold, navy accent only for the single primary
  action, glass rail and frosted cards, no glow, no neon, no orange. Status by glyph and word, never colour alone.
- Helpers only read and prepare. No send, share, memory write or action path is added. They are TARS's helpers:
  no roster, avatars or bot names.
- Respect reduced motion. Panel: Open app and Stop for now stay above the fold (existing rule).

**Assumptions made instead of asking.**
- "Reading one source / several" in the state list means drafting with one or several source kinds: the kinds are
  only known once the evidence has been read and selected, so the reading stage itself shows no chips.
- A failed run keeps its card (Needs retry) until the user retries, dismisses it, or new evidence starts a new run.

## Direction

Brainstormed answers to the moment:
1. A card per preparation: project, the stage in words, the sources as chips. (Task component pattern.)
2. A step ladder per card: the three real stages listed with done / now / next.
3. One collapsed line: "TARS is preparing 2 projects", expandable.
4. Sources as lanes drawn merging into the draft (signature visual for research work).
5. Only a pet state change, nothing on screen.

**Chosen: 1 with a compressed 2.** One card each, because several can run at once and each needs its own words and
sources; the ladder is compressed into a three-square stage track beside the words so the panel can hold it. 3 hides
the very thing that builds trust; 4 is decoration at this size and invents motion the work does not have; 5 is not
visible enough for a failure.

Signatures: **visual**, the three-square stage track in the pet's dot-matrix language (filled done, blinking now,
hollow next); **motion**, the current square blinks at the typing cursor's rhythm (500 ms lit / 500 ms hollow), new
stage words crossfade up 3 px, chips open their row when drafting starts, a card opens its own space on arrival and
closes it on leaving.
