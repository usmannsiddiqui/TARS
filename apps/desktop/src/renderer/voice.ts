// One explicit microphone session. Start it only from a Record click, after window.companion.dictation.begin().
// It stops itself at the size limit or at a single one-shot duration deadline; cancel releases the microphone.
export type Captured = { bytes: Uint8Array; mimeType: string };
export type VoiceSession = { stop(): Promise<Captured>; cancel(): void };
export type VoiceLimits = { maxBytes: number; maxDurationMs: number };

// The recorder hands over a chunk about every second (opus: a few KB each); this headroom keeps the
// finished recording under the main-process byte limit even with one more chunk in flight.
const SIZE_HEADROOM = 256 * 1024;
const CHUNK_MS = 1000;

/** Throws when the microphone is unavailable or denied; the caller keeps typing usable. */
export async function startVoice(limits: VoiceLimits, onLimit: (why: "size" | "time") => void): Promise<VoiceSession> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  let size = 0;
  let released = false;
  // The one timer in the companion: a single deadline for this recording, never repeated.
  const deadline = setTimeout(() => onLimit("time"), limits.maxDurationMs);
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(deadline);
    for (const track of stream.getTracks()) track.stop(); // the macOS mic indicator turns off here
  };
  const stopped = new Promise<void>((done) => recorder.addEventListener("stop", () => done(), { once: true }));
  recorder.addEventListener("dataavailable", (event) => {
    if (released || event.data.size === 0) return;
    chunks.push(event.data);
    size += event.data.size;
    if (size >= limits.maxBytes - SIZE_HEADROOM) onLimit("size");
  });
  recorder.start(CHUNK_MS);

  return {
    async stop() {
      if (recorder.state !== "inactive") recorder.stop();
      await stopped; // the final chunk arrives before "stop"
      release();
      const blob = new Blob(chunks, { type: recorder.mimeType });
      return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type || recorder.mimeType };
    },
    cancel() {
      release();
      chunks.length = 0;
      if (recorder.state !== "inactive") recorder.stop();
    },
  };
}
