// Hold to talk, as pure rules: one hold is one recording; a press shorter than MIN_HOLD_MS records nothing.
// The pet's pill drives the microphone from these states; the dictation pipeline itself is unchanged.

/** Shorter holds are taps: nothing is recorded or uploaded. */
export const MIN_HOLD_MS = 250;
export const HOLD_HINT = "Hold to talk";

export type Talk =
  | { kind: "idle"; note?: string }
  | { kind: "starting"; pressedAt: number }
  | { kind: "listening"; pressedAt: number }
  | { kind: "transcribing" }
  | { kind: "ready" }
  | { kind: "failed"; message: string };

export type TalkEvent =
  | { type: "press"; at: number }
  /** The microphone is live. */
  | { type: "started" }
  | { type: "release"; at: number }
  /** The recorder reached the size or time limit: stop as if released. */
  | { type: "limit" }
  /** The transcript is in the capture box. */
  | { type: "transcribed" }
  | { type: "failed"; message: string };

export const TALK_IDLE: Talk = { kind: "idle" };

export function talkNext(s: Talk, e: TalkEvent): Talk {
  switch (e.type) {
    case "press":
      return s.kind === "idle" || s.kind === "ready" || s.kind === "failed" ? { kind: "starting", pressedAt: e.at } : s;
    case "started":
      return s.kind === "starting" ? { kind: "listening", pressedAt: s.pressedAt } : s;
    case "release":
      if (s.kind === "starting") return { kind: "idle", note: HOLD_HINT };
      if (s.kind === "listening") return e.at - s.pressedAt < MIN_HOLD_MS ? { kind: "idle", note: HOLD_HINT } : { kind: "transcribing" };
      return s;
    case "limit":
      return s.kind === "listening" ? { kind: "transcribing" } : s;
    case "transcribed":
      return s.kind === "transcribing" ? { kind: "ready" } : s;
    case "failed":
      return { kind: "failed", message: e.message };
  }
}
