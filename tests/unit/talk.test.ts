// Hold to talk: one recording per hold, the too-short press, and the states the pill shows.
import { describe, expect, it } from "vitest";
import { MIN_HOLD_MS, TALK_IDLE, talkNext, type Talk, type TalkEvent } from "../../apps/desktop/src/renderer/talk";

const run = (...events: TalkEvent[]) => events.reduce<Talk>(talkNext, TALK_IDLE);
const press = (at = 0): TalkEvent => ({ type: "press", at });
const release = (at: number): TalkEvent => ({ type: "release", at });
const started: TalkEvent = { type: "started" };

describe("talkNext", () => {
  it("idle_to_listening_to_transcribing_to_ready", () => {
    expect(run(press(0)).kind).toBe("starting");
    expect(run(press(0), started)).toEqual({ kind: "listening", pressedAt: 0 });
    expect(run(press(0), started, release(MIN_HOLD_MS)).kind).toBe("transcribing");
    expect(run(press(0), started, release(MIN_HOLD_MS), { type: "transcribed" }).kind).toBe("ready");
  });

  it("a_press_shorter_than_the_threshold_records_nothing_and_says_hold_to_talk", () => {
    expect(MIN_HOLD_MS).toBe(250);
    expect(run(press(1000), started, release(1000 + MIN_HOLD_MS - 1))).toEqual({ kind: "idle", note: "Hold to talk" });
    // Released before the microphone was even live.
    expect(run(press(1000), release(1400))).toEqual({ kind: "idle", note: "Hold to talk" });
    // The microphone coming up after the release changes nothing: the caller releases it.
    expect(run(press(1000), release(1100), started)).toEqual({ kind: "idle", note: "Hold to talk" });
  });

  it("a_limit_stops_the_recording_like_a_release", () => {
    expect(run(press(0), started, { type: "limit" }).kind).toBe("transcribing");
    // The release that follows a limit stop is not a second stop.
    expect(run(press(0), started, { type: "limit" }, release(400_000)).kind).toBe("transcribing");
  });

  it("failure_says_what_happened_and_a_new_hold_starts_again", () => {
    const failed = run(press(0), started, release(900), { type: "failed", message: "Transcription failed." });
    expect(failed).toEqual({ kind: "failed", message: "Transcription failed." });
    expect(talkNext(failed, press(5000)).kind).toBe("starting");
    expect(run(press(0), { type: "failed", message: "Microphone access is off for TARS." }).kind).toBe("failed");
  });

  it("presses_while_busy_are_ignored_so_one_hold_is_one_recording", () => {
    expect(run(press(0), press(10)).kind).toBe("starting");
    expect(run(press(0), started, press(10))).toEqual({ kind: "listening", pressedAt: 0 });
    expect(run(press(0), started, release(900), press(1000)).kind).toBe("transcribing");
    expect(run(release(5)).kind).toBe("idle");
  });
});
