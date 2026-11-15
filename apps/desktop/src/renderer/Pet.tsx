// The desktop pet: TARS, and the control pill beneath it. The figure is presentational (state and actions
// arrive as props); the pill's voice button drives the existing dictation pipeline, like the capture box.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { gaze, isDrag } from "../main/pet";
import type { HoldKeyStatus } from "../preload/index";
import type { PetState } from "./model";
import { MIN_HOLD_MS, TALK_IDLE, talkNext, type Talk, type TalkEvent } from "./talk";
import { PET_LABEL, PetFigure, reason } from "./ui";
import { DICTATION_FAILURE, startVoice, type VoiceSession } from "./voice";

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const KEY_STEP = 10;
const KEY_STEP_LARGE = 50;
/** Per animation frame, the eyes cover this share of the way to the pointer: settled in about 200ms. */
const GAZE_EASE = 0.2;
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export type PetProps = {
  state: PetState;
  /** The held talk key's status, for the voice button's description; null while unknown. */
  talkKey: HoldKeyStatus | null;
  /** The held talk key is down right now (pushed by main from the native helper). */
  keyHeld: boolean;
  onOpen(): void;
  onMove(dx: number, dy: number): void;
  /** The button went down on the figure, came up in place ("up"), or came up after a drag ("dragged"). */
  onPress(phase: "down" | "up" | "dragged"): void;
  /** The pointer entered or left the figure (not the pill): main decides whether the panel opens. */
  onHover(over: boolean): void;
  onCompose(): void;
};

/**
 * The pet window's content: TARS standing alone on the transparent window, the pill below. The state word
 * is on TARS's own dark screen, so it reads over any wallpaper. Press and drag the figure to move it
 * (pointer capture keeps the drag when the pointer outruns the window); a press that barely moves is a
 * click. Arrow keys move it too. Hovering, TARS looks at the pointer and its outer slabs say hello.
 */
export function Pet({ state, talkKey, keyHeld, onOpen, onMove, onPress, onHover, onCompose }: PetProps) {
  const hint = useId();
  const figure = useRef<HTMLButtonElement>(null);
  const press = useRef<{ startX: number; startY: number; lastX: number; lastY: number; dragging: boolean } | null>(null);
  const dragged = useRef(false);
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);

  // Gaze: eased toward the pointer on animation frames, written as CSS variables; the loop stops when settled.
  const target = useRef({ x: 0, y: 0 });
  const current = useRef({ x: 0, y: 0 });
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const tick = () => {
    const c = current.current;
    const t = target.current;
    c.x += (t.x - c.x) * GAZE_EASE;
    c.y += (t.y - c.y) * GAZE_EASE;
    const settled = Math.abs(t.x - c.x) < 0.005 && Math.abs(t.y - c.y) < 0.005;
    if (settled) current.current = { ...t };
    figure.current?.style.setProperty("--gx", current.current.x.toFixed(3));
    figure.current?.style.setProperty("--gy", current.current.y.toFixed(3));
    frame.current = settled ? 0 : requestAnimationFrame(tick);
  };
  const aim = (to: { x: number; y: number }) => {
    target.current = to;
    if (!frame.current && !reducedMotion()) frame.current = requestAnimationFrame(tick);
  };

  const down = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = { startX: e.screenX, startY: e.screenY, lastX: e.screenX, lastY: e.screenY, dragging: false };
    dragged.current = false;
    setPressed(true);
    aim({ x: 0, y: 0 });
    onPress("down"); // main closes a hover-opened panel and opens nothing while the button is down
  };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p) return aim(gaze({ x: e.clientX, y: e.clientY }, e.currentTarget.getBoundingClientRect()));
    if (!p.dragging && !isDrag(e.screenX - p.startX, e.screenY - p.startY)) return;
    p.dragging = dragged.current = true;
    // Screen coordinates, not client ones: the window moves under the pointer while it drags.
    const dx = Math.round(e.screenX - p.lastX);
    const dy = Math.round(e.screenY - p.lastY);
    if (dx === 0 && dy === 0) return;
    p.lastX += dx;
    p.lastY += dy;
    onMove(dx, dy);
  };
  const up = (cancelled: boolean) => {
    if (!press.current) return;
    press.current = null;
    setPressed(false);
    onPress(dragged.current || cancelled ? "dragged" : "up");
  };
  const key = (e: KeyboardEvent<HTMLButtonElement>) => {
    const dir = ARROWS[e.key];
    if (!dir) return;
    e.preventDefault();
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    onMove(dir[0] * step, dir[1] * step);
  };
  const over = (on: boolean) => {
    setHover(on);
    if (!on) aim({ x: 0, y: 0 });
    onHover(on);
  };

  return (
    <div className="pet-root">
      <button
        ref={figure}
        type="button"
        className="pet"
        data-state={state}
        data-hover={hover && !pressed ? "on" : "off"}
        aria-label={`Open companion panel. ${PET_LABEL[state]}.`}
        aria-describedby={hint}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={() => up(false)}
        onPointerCancel={() => up(true)}
        onPointerEnter={() => over(true)}
        onPointerLeave={() => over(false)}
        onKeyDown={key}
        // A drag ends in a click event too; only a press that stayed put opens the panel.
        onClick={() => (dragged.current ? void (dragged.current = false) : onOpen())}
      >
        <PetFigure state={state} />
        <span id={hint} hidden>
          Rest the pointer here to see today. Drag to move, or use the arrow keys; hold Shift for bigger steps.
        </span>
      </button>
      <TalkPill talkKey={talkKey} keyHeld={keyHeld} onCompose={onCompose} />
    </div>
  );
}

const MIC_OFF = "Microphone access is off for TARS.";
const keyDescription = (s: HoldKeyStatus | null) =>
  !s || s.state === "starting" || s.state === "ready"
    ? `Or hold ${s?.key ?? "Right Option (⌥)"} anywhere.`
    : s.state === "permission-missing"
      ? `Holding ${s.key} anywhere needs Accessibility access for TARS; see Connections.`
      : `Holding ${s.key} to talk is unavailable right now.`;

/**
 * Compose and hold-to-talk, under TARS. Holding the voice button (or the talk key) records; releasing
 * transcribes through the existing dictation upload, then the panel opens pinned with the transcript in
 * the editable capture box. Nothing is saved or sent until the user presses Save there. The microphone is
 * open only while held.
 */
function TalkPill({ talkKey, keyHeld, onCompose }: { talkKey: HoldKeyStatus | null; keyHeld: boolean; onCompose(): void }) {
  const describe = useId();
  // The state lives in a ref so the async steps below read the latest one; the render copy follows it.
  const talk = useRef<Talk>(TALK_IDLE);
  const [view, setView] = useState<Talk>(TALK_IDLE);
  const [micOff, setMicOff] = useState(false);
  const session = useRef<VoiceSession | null>(null);
  const send = (e: TalkEvent) => {
    const before = talk.current;
    talk.current = talkNext(before, e);
    setView(talk.current);
    return { before, after: talk.current };
  };
  const fail = (message: string) => send({ type: "failed", message });

  // `at`: when the press or release happened (the event's own time), so a busy page never stretches a tap.
  async function hold(at: number) {
    const { before, after } = send({ type: "press", at });
    if (before === after) return; // already recording or transcribing: one hold is one recording
    setMicOff(false);
    try {
      const { microphone } = await window.companion.dictation.begin();
      if (microphone === "denied") {
        setMicOff(true);
        return void fail(MIC_OFF);
      }
      const voice = await startVoice(window.companion.dictation.limits, () => stop("limit", performance.now()));
      if (talk.current.kind !== "starting") return voice.cancel(); // let go before the microphone was live: nothing kept
      session.current = voice;
      send({ type: "started" });
    } catch (err) {
      fail(`Could not start recording: ${reason(err)}.`);
    }
  }

  function stop(why: "release" | "limit", at: number) {
    const { before, after } = send(why === "limit" ? { type: "limit" } : { type: "release", at });
    if (before.kind !== "listening") return;
    const voice = session.current;
    session.current = null;
    if (after.kind === "transcribing" && voice) void transcribe(voice);
    else voice?.cancel(); // too short: the microphone closes and nothing is kept
  }

  async function transcribe(voice: VoiceSession) {
    try {
      const { bytes, mimeType } = await voice.stop(); // the microphone is released here
      const result = await window.companion.dictation.finish(bytes, mimeType);
      if (!result.ok) return void fail(DICTATION_FAILURE[result.code] ?? "Dictation failed.");
      if (result.text.trim() === "") {
        await window.companion.dictation.discard(result.recoveryId); // silence: there are no words to keep
        return void fail("Nothing was heard. Hold to talk, then speak.");
      }
      await window.companion.openCapture({ text: result.text, recoveryId: result.recoveryId });
      send({ type: "transcribed" });
    } catch (err) {
      fail(`Dictation failed: ${reason(err)}.`);
    }
  }

  // Unmounting mid-hold closes the microphone; nothing is kept.
  useEffect(() => () => session.current?.cancel(), []);
  // The held key arrives as down/up from main: the same hold as the pointer's. Repeats change nothing.
  const holding = useRef(false);
  useEffect(() => {
    if (keyHeld === holding.current) return;
    holding.current = keyHeld;
    if (keyHeld) void hold(performance.now());
    else stop("release", performance.now());
  });

  const listening = view.kind === "listening";
  const word = listening ? "Listening" : view.kind === "transcribing" ? "Transcribing…" : view.kind === "idle" ? (view.note ?? "") : "";
  const keyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) {
      e.preventDefault();
      void hold(e.timeStamp);
    }
  };
  const keyUp = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === " " || e.key === "Enter") stop("release", e.timeStamp);
  };

  return (
    <div className="pet-controls" data-talk={view.kind}>
      <div className="pet-pill">
        <button type="button" className="pill-key" aria-label="Capture an idea" title="Capture an idea" onClick={onCompose}>
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="pill-icon">
            <path d="M8.4 3.6H4.6a1 1 0 0 0-1 1v8.8a1 1 0 0 0 1 1h8.8a1 1 0 0 0 1-1V9.6" />
            <path d="M12.9 2.8a1.35 1.35 0 0 1 1.9 1.9L9.4 10.1l-2.6.7.7-2.6Z" />
          </svg>
        </button>
        <span className="pill-divider" aria-hidden="true" />
        <button
          type="button"
          className="pill-key"
          aria-label="Hold to talk"
          aria-describedby={describe}
          title={`Hold to talk. ${keyDescription(talkKey)}`}
          data-listening={listening ? "on" : "off"}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            void hold(e.timeStamp);
          }}
          onPointerUp={(e) => stop("release", e.timeStamp)}
          onPointerCancel={(e) => stop("release", e.timeStamp)}
          onLostPointerCapture={(e) => stop("release", e.timeStamp)}
          onKeyDown={keyDown}
          onKeyUp={keyUp}
        >
          {listening ? (
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="pill-icon pill-level">
              <rect className="pill-bar" x="3.5" y="5" width="2.2" height="8" rx="1.1" />
              <rect className="pill-bar" x="7.9" y="2.5" width="2.2" height="13" rx="1.1" />
              <rect className="pill-bar" x="12.3" y="5" width="2.2" height="8" rx="1.1" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="pill-icon">
              <path d="M3 7.8v2.4M6 5.4v7.2M9 2.8v12.4M12 5.4v7.2M15 7.8v2.4" />
            </svg>
          )}
        </button>
        <span className="pill-word" role="status" aria-live="polite">
          {word}
          {/* Elapsed time is a CSS counter (screens.css .tape-run): no timer ticks in JS. */}
          {listening && <span className="pill-time tape-run" aria-hidden="true" />}
        </span>
      </div>
      <span id={describe} hidden>
        Press and hold to talk; let go to put the words in the capture box to edit. Shorter than {MIN_HOLD_MS / 1000} seconds records
        nothing. {keyDescription(talkKey)}
      </span>
      {view.kind === "failed" && (
        <p className="pet-note" role="alert">
          {view.message}
          {micOff && (
            <button type="button" className="pet-note-link" onClick={() => void window.companion.dictation.openMicrophoneSettings()}>
              Open settings
            </button>
          )}
        </p>
      )}
    </div>
  );
}
