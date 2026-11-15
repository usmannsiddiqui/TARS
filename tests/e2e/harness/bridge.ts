// TEST-ONLY stand-in for the preload bridge, for screens that call it directly (the Composer).
// It records calls for the spec and never reaches a main process, a microphone or the network.
import { DICTATION_LIMITS } from "../../../apps/desktop/src/main/dictation-limits";

const calls: unknown[][] = [];
const record = (...args: unknown[]) => void calls.push(args);
const g = globalThis as unknown as { __calls: unknown[][]; companion: unknown };
g.__calls = calls;
// A silent stream in place of the microphone for "-recording" scenes: no device, no OS prompt.
const page = globalThis as unknown as { location: { hash: string }; navigator: { mediaDevices: { getUserMedia: unknown } }; AudioContext: new () => { createMediaStreamDestination(): { stream: unknown } } };
if (page.location.hash.endsWith("-recording")) page.navigator.mediaDevices.getUserMedia = async () => new page.AudioContext().createMediaStreamDestination().stream;

g.companion = {
  saveCapture: async (input: { text: string }) => (record("saveCapture", input.text), { id: "capture-illustrative", saved: true, summary: input.text }),
  onCaptureOpen: () => () => undefined,
  dictation: {
    limits: DICTATION_LIMITS,
    listRecoverable: async () => [],
    // "#…-recording" scenes get a granted microphone that is a silent generated stream, never a device.
    begin: async () => (record("dictation.begin"), { microphone: page.location.hash.endsWith("-recording") ? "granted" : "denied" }),
    acknowledge: async (id: string) => record("dictation.acknowledge", id),
  },
};

export { record };
