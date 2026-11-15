// TEST-ONLY stand-in for the preload bridge, for screens that call it directly (the Composer).
// It records calls for the spec and never reaches a main process, a microphone or the network.
import { DICTATION_LIMITS } from "../../../apps/desktop/src/main/dictation-limits";

const calls: unknown[][] = [];
const record = (...args: unknown[]) => void calls.push(args);
const g = globalThis as unknown as { __calls: unknown[][]; companion: unknown; __finishTranscription?: () => void };
g.__calls = calls;
// Stubbed transcription: dictation.finish waits until the spec calls __finishTranscription(), so the
// "Transcribing…" state can be seen; then it returns illustrative text. No audio leaves the page.
let transcribed: () => void = () => undefined;
const transcription = () => new Promise<void>((done) => ((transcribed = done), (g.__finishTranscription = () => transcribed())));
// A silent stream in place of the microphone for "-recording" scenes: no device, no OS prompt.
const page = globalThis as unknown as { location: { hash: string }; navigator: { mediaDevices: { getUserMedia: unknown } }; AudioContext: new () => { createMediaStreamDestination(): { stream: unknown } } };
if (page.location.hash.endsWith("-recording")) page.navigator.mediaDevices.getUserMedia = async () => new page.AudioContext().createMediaStreamDestination().stream;

g.companion = {
  saveCapture: async (input: { text: string }) => (record("saveCapture", input.text), { id: "capture-illustrative", saved: true, summary: input.text }),
  openCapture: async (transcript?: { text: string; recoveryId: string }) => record("openCapture", transcript),
  dictation: {
    limits: DICTATION_LIMITS,
    listRecoverable: async () => [],
    // "#…-recording" scenes get a granted microphone that is a silent generated stream, never a device.
    begin: async () => (record("dictation.begin"), { microphone: page.location.hash.endsWith("-recording") ? "granted" : "denied" }),
    acknowledge: async (id: string) => record("dictation.acknowledge", id),
    finish: async (_bytes: Uint8Array, mime: string) => {
      record("dictation.finish", mime.split("/")[0]);
      await transcription();
      return { ok: true, text: "Ask the AV lead for a second wireless mic", recoveryId: "rec_illustrative" };
    },
    discard: async (id: string) => record("dictation.discard", id),
    openMicrophoneSettings: async () => record("dictation.openMicrophoneSettings"),
  },
};

export { record };
