// The companion's editable capture box. Typing or dictation fills it; nothing is saved or sent until Save.
// A dictation's spooled audio is acknowledged (deleted) only after the save that holds its text resolves.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { CaptureInput } from "@companion/domain";
import type { DictationResult, Transcript } from "../preload/index";
import { reason, StateNote } from "./ui";
import { DICTATION_FAILURE, startVoice, type VoiceSession } from "./voice";

type Voice =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "recording"; session: VoiceSession }
  | { kind: "transcribing" };
type Failed = { recoveryId: string; message: string };

const { limits } = window.companion.dictation;
const LIMIT_TEXT = `Dictation records up to ${limits.maxDurationMs / 60_000} min or ${limits.maxBytes / 1_000_000} MB, then stops by itself.`;
const clock = (ms: number) => `${String(Math.floor(ms / 60_000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

/**
 * `onSaved`: the capture is durably on this Mac (for lists that show captures). `transcript`: a hold-to-talk
 * transcript to start from, editable and unsaved. `autoFocus`: focus the box with the caret at the end.
 * `send`: the project chat's composer. The text goes to TARS (stored in the thread) instead of the
 * capture queue; Return sends, Shift+Return is a new line.
 */
export function Composer({
  projectId,
  onSaved,
  transcript,
  autoFocus,
  send,
}: {
  projectId?: string;
  onSaved?(): void;
  transcript?: Transcript;
  autoFocus?: boolean;
  send?(text: string): Promise<void>;
}) {
  const id = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(transcript?.text ?? "");
  const [voice, setVoice] = useState<Voice>({ kind: "idle" });
  const [status, setStatus] = useState(transcript ? "Transcript added. Edit it, then Save." : "");
  const [saving, setSaving] = useState(false);
  // Transcripts now in the box, acknowledged only after the save that contains them.
  const [pending, setPending] = useState<string[]>(transcript ? [transcript.recoveryId] : []);
  const [failed, setFailed] = useState<Failed[]>([]);
  const stopping = useRef(false);
  const live = useRef<VoiceSession | null>(null);

  // Leaving the composer mid-recording releases the microphone; nothing is kept.
  useEffect(() => () => live.current?.cancel(), []);

  // Opened for capture (the shortcut, Compose, a finished hold to talk): ready to type at the end. Never records.
  useEffect(() => {
    const el = box.current;
    if (!autoFocus || !el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
    el.closest("form")?.scrollIntoView({ block: "end" }); // the whole card: box, Save and the status line
  }, [autoFocus]);

  // Recordings left from a crash or an earlier failure: offer them, never transcribe on our own.
  useEffect(() => {
    window.companion.dictation.listRecoverable().then(
      (found) =>
        setFailed(
          found
            .filter((r) => r.recoveryId !== transcript?.recoveryId) // its words are in the box already
            .map((r) => ({ recoveryId: r.recoveryId, message: "A recording from earlier was not saved yet." })),
        ),
      () => {}, // signed out: there is nothing to recover for this owner yet
    );
  }, [transcript?.recoveryId]);

  function take(result: DictationResult, retried?: string) {
    if (result.ok) {
      setText((current) => (current.trim() === "" ? result.text : `${current.trimEnd()}\n${result.text}`));
      setPending((ids) => [...ids, result.recoveryId]);
      setFailed((list) => list.filter((f) => f.recoveryId !== result.recoveryId));
      setStatus("Transcript added. Edit it, then Save.");
      box.current?.focus();
      return;
    }
    const message = DICTATION_FAILURE[result.code] ?? "Dictation failed.";
    const recoveryId = result.recoveryId ?? retried;
    if (recoveryId) setFailed((list) => [...list.filter((f) => f.recoveryId !== recoveryId), { recoveryId, message }]);
    setStatus(message);
  }

  async function record() {
    setVoice({ kind: "starting" });
    setStatus("");
    try {
      const { microphone } = await window.companion.dictation.begin();
      if (microphone === "denied") {
        setVoice({ kind: "idle" });
        setStatus("Microphone access is off for TARS. Typing still works; you can allow it in System Settings.");
        return;
      }
      stopping.current = false;
      const session = await startVoice(limits, () => void stop(session));
      live.current = session;
      setVoice({ kind: "recording", session });
    } catch (err) {
      setVoice({ kind: "idle" });
      setStatus(`Could not start recording: ${reason(err)}. Typing still works.`);
    }
  }

  async function stop(session: VoiceSession) {
    if (stopping.current) return; // a limit and a click can both ask to stop
    stopping.current = true;
    live.current = null;
    setVoice({ kind: "transcribing" });
    try {
      const { bytes, mimeType } = await session.stop();
      take(await window.companion.dictation.finish(bytes, mimeType));
    } catch (err) {
      setStatus(`Dictation failed: ${reason(err)}`);
    } finally {
      setVoice({ kind: "idle" });
    }
  }

  function cancel(session: VoiceSession) {
    stopping.current = true;
    live.current = null;
    session.cancel();
    setVoice({ kind: "idle" });
    setStatus("Recording cancelled. Nothing was kept.");
  }

  async function retry(recoveryId: string) {
    setStatus("Transcribing…");
    try {
      take(await window.companion.dictation.retry(recoveryId), recoveryId);
    } catch (err) {
      setStatus(`Retry failed: ${reason(err)}`);
    }
  }

  async function discard(recoveryId: string) {
    try {
      await window.companion.dictation.discard(recoveryId);
      setFailed((list) => list.filter((f) => f.recoveryId !== recoveryId));
      setStatus("Recording discarded.");
    } catch (err) {
      setStatus(`Could not discard: ${reason(err)}`);
    }
  }

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (text.trim() === "" || saving) return;
    setSaving(true);
    if (send) {
      try {
        await send(text);
        // Stored in the thread: only now may the spooled audio behind this text be deleted.
        const acknowledged = pending;
        setText("");
        setPending([]);
        setStatus("");
        await Promise.all(acknowledged.map((recoveryId) => window.companion.dictation.acknowledge(recoveryId)));
      } catch (err) {
        setStatus(`Not sent: ${reason(err)}. Your text and any recording are kept.`);
      } finally {
        setSaving(false);
      }
      return;
    }
    try {
      const input: CaptureInput = {
        text,
        origin: pending.length > 0 ? "dictated" : "typed",
        ...(projectId ? { projectHint: projectId as NonNullable<CaptureInput["projectHint"]> } : {}),
      };
      const receipt = await window.companion.saveCapture(input);
      // Durably saved: only now may the spooled audio behind this text be deleted.
      const acknowledged = pending;
      setText("");
      setPending([]);
      setStatus(`Saved on this Mac: ${receipt.summary}`);
      onSaved?.();
      await Promise.all(acknowledged.map((recoveryId) => window.companion.dictation.acknowledge(recoveryId)));
    } catch (err) {
      setStatus(`Not saved: ${reason(err)}. Your text and any recording are kept.`);
    } finally {
      setSaving(false);
    }
  }

  const busy = voice.kind === "starting" || voice.kind === "transcribing";
  return (
    <form className={send ? "capture chat-composer" : "capture"} onSubmit={save} aria-label={send ? "Message TARS" : "Capture"}>
      <label htmlFor={id} className={send ? "sr-only" : "block-title"}>
        {send ? "Message TARS" : "Capture an idea"}
      </label>
      <textarea
        id={id}
        ref={box}
        value={text}
        rows={send ? 2 : 3}
        placeholder={send ? "Tell TARS what to change, ask about this project, or say send it." : "Type, or press Record to dictate. Nothing is saved until you press Save."}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey || (send && !e.shiftKey))) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="tape-deck" data-state={voice.kind}>
        <p className="tape-window">
          {/* The running counter is CSS (screens.css .tape-run), so no timer ticks in JS. */}
          <span className="tape-counter" aria-hidden="true">
            {voice.kind === "recording" ? <span className="tape-run" /> : "00:00"}
          </span>
          <span className="tape-limit">
            <span aria-hidden="true">/ {clock(limits.maxDurationMs)}</span> · {limits.maxBytes / 1_000_000} MB max
          </span>
          <span className="sr-only">{voice.kind === "recording" ? "Recording now." : "Not recording."}</span>
        </p>
        <span className="row-actions tape-keys">
          {voice.kind === "recording" ? (
            <>
              <button type="button" className="secondary tape-key" data-key="stop" onClick={() => void stop(voice.session)}>
                Stop recording
              </button>
              <button type="button" className="secondary tape-key" data-key="eject" onClick={() => cancel(voice.session)}>
                Cancel recording
              </button>
            </>
          ) : (
            <button type="button" className="secondary tape-key" data-key="record" disabled={busy} onClick={() => void record()}>
              {voice.kind === "transcribing" ? "Transcribing…" : voice.kind === "starting" ? "Starting…" : "Record"}
            </button>
          )}
        </span>
      </div>
      <div className="capture-foot">
        <p className="hint">
          {voice.kind === "recording" ? "Recording now. Stop to transcribe, or Cancel to keep nothing." : send ? "Return sends. Shift Return adds a line." : `${LIMIT_TEXT} ⌘ Return saves.`}
        </p>
        <button type="submit" className="secondary" disabled={saving || text.trim() === ""}>
          {send ? (saving ? "Sending…" : "Send") : "Save"}
        </button>
      </div>
      {failed.map((f) => (
        <StateNote key={f.recoveryId} state={{ kind: "needs-retry", detail: f.message }}>
          <span className="row-actions">
            <button type="button" className="text-button" onClick={() => void retry(f.recoveryId)}>
              Retry
            </button>
            <button type="button" className="text-button" onClick={() => void discard(f.recoveryId)}>
              Discard
            </button>
          </span>
        </StateNote>
      ))}
      <p role="status" aria-live="polite" className="capture-status">
        {saving ? (send ? "" : "Saving…") : status}
      </p>
    </form>
  );
}
