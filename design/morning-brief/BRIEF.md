# Morning brief layout: brief

**Who.** One entrepreneur with ADHD opening the app in the morning, often on the default 1200x800 window. They want
to know, in one look, what TARS prepared, whether they can trust it, and where to start.

**The moment.** TARS prepared the morning brief at 9:00 local time (a scheduled deadline, no model call). The user
opens Today any time after, or before 9:00 when nothing is ready yet. The brief can be missing (first day, before
9:00), the brief service can fail to answer (Needs retry), or the brief can be empty (nothing due, nothing
suggested). Re-entry after days away and the evening recap keep their own hero.

**What the system knows** (pushed by subscription, nothing estimated):
- the stored brief: meetings and real due dates (with source and freshness), suggested work, one recommended start
  with its reason, triage, stale sources, when it was prepared;
- new: what the brief read, per kind, with a real count (today's calendar items, Canvas deadlines in the next seven
  days, items from other sources received since the previous brief, your open commitments). Older briefs carry none;
- the schedule: the next morning run as an instant and the timezone; the brief runs every day at that local time.

**Success, as behaviour.**
- They read the recommended start and press the one navy button instead of scanning every list.
- They trust the brief because they can see what it read, with counts that match their sources; nothing decorative.
- Before 9:00 they see when it will come, not an empty page; on failure they know it failed.
- TARS at the front desk is still there, visible without scrolling at 1200x800.

**Constraints.** TARS's decided look: light studio grey, black Helvetica Neue Bold, navy `#1F3460` only on the single
primary action, frosted cards, no glow, no orange, no green pills; state is glyph + word. One h1; the brief is a real
ordered list, the read rows a real list; keyboard order follows reading order. The brief sends, shares, changes and
remembers nothing. Reduced motion respected.

## Direction
Considered: (1) the reference's routine card and rows beside the desk; (2) sources drawn as lanes merging into the
brief (a signature visual, but too tall for 800px next to the desk); (3) the read rows as one line of source chips
(dense, but loses the reference's sentence-per-source honesty). Chosen: (1), built from TARS's own parts (frosted
card, state glyph + word, source logos, hairline rows) in the hero's left column, the desk on the right. Signature
motion stays TARS's typed recommended start; rows and actions rise in once.
