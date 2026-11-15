# Spec: morning brief on Today

Tags: [P] TARS design system (visual primary), [R] the user's reference screenshot (structure and words), [DS] TARS
tokens, [B] brief, [C] skill craft default.

## Tokens
- Greeting 28/700/-0.02em `--ink`; the day beside it 17/400 `--ink-2` [R structure, DS type]
- Routine card: `.block` frosted glass, radius 14, padding 12/16; icon tile 36px, radius 8, `--glass-inner` with a
  1px hairline ring [R anatomy, DS material]
- Card name 17/700/-0.01em (`.block-title` treatment); schedule 14 `--ink-2`, one line [DS]
- State: `StateTag` glyph + words at 14/500 in `--ink`; Needs retry on the black plate [DS state rule]
- Read rows: 36px min, 15px text, 28px logo tile radius 8, hairline under each row, check glyph in `--ink` [R]
- Brief: h3 17/700 + "Saturday · 9:00 AM" 14 `--ink-2`; ordered list 15/1.4, 8px between items, markers `--ink-2`
  tabular [R]; the recommended start: black label 12/700 radius 4, typed sentence 20/700, reason 14, actions [DS]
- Next line 14 `--ink-2` [R]
- Motion: rows and actions rise 400ms `--ease-out` once; the recommended sentence types (existing `Typed`); global
  reduced-motion rule stops both, the sentence shows whole [DS]

## Anatomy (hero left column; desk right)
1. Greeting + day
2. Routine card: tile · "Morning brief" / "Every day · 9:00 AM" · state · prepared time
3. Needs retry note (only on failure)
4. "What TARS read for this brief": one row per kind really read (list)
5. "Morning brief" / day · time, then the brief as an ordered list (max 5): recommended start first with reason and
   Help me start (navy, the only primary) + Improve content first; then meetings and due dates ("meeting Sat 3:00 PM
   · AVT", "due Thu 5:00 PM · Coursework"), then suggestions ("suggested · AI Guides")
6. "Next brief: tomorrow, 9:00 AM"
7. Other ways to start (existing)
The full Meetings and deadlines / Suggested work / May be out of date sections stay below with sources and triage.

## Content
Row sentences from the stored count only: "Read today's 3 meetings" / "Read today's meeting", "Read 4 new emails",
"Checked 2 Canvas deadlines", "Read 14 new Slack messages", "Looked over 1 Notion update", "Looked over 5 changed
notes", "Went through 6 open commitments" [R pattern]. Greeting by local hour (morning / afternoon / evening).

## States
| Axis | Decision |
|---|---|
| Amount | no record (older brief) or nothing connected: no rows; 1 to 13 kinds: one row each; brief items capped at 5 |
| Shape | long recommended start: wraps, balanced, no truncation; long item text wraps (`overflow-wrap: anywhere`) |
| Time | loading: "Reading" + "Reading today's brief…"; before the first run: "Waiting until 9:00 AM", "No brief prepared yet", next line |
| Outcome | prepared: "Prepared" + time; empty brief: "Nothing is due and nothing is suggested yet"; failure: "Needs retry" on the plate + the reason; the last brief stays readable |
| Interaction | tab order: rows are not focusable; Help me start, Improve content first, then other ways to start |
| Environment | 1200x800: desk on the first screen beside the card; 1280x900 the same; reduced motion: nothing rises or types |

## Departures
- The desk sits at the top of the hero (not at its foot) so it stays on the first screen with a taller brief; the floor
  runs under the desk only.
- Glass on the routine card (audit warns): TARS's decided material.
- Not taken from the reference: its colours, serif, green Done pill, "Weekdays", uncounted rows.
