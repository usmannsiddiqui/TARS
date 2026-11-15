// Nudges texted to the user's own phone through Messages on this Mac. The only recipient is the one
// handle the user saved here; nothing reads messages or lists chats. index.ts injects execFile and prefs.
import { z } from "zod";

const PHONE = /^\+[1-9]\d{6,14}$/; // E.164: international form, digits only
/** The user's own iMessage handle: a phone number in international form or an Apple ID email. */
export const SelfTextSettingSchema = z.strictObject({
  enabled: z.boolean(),
  handle: z.union([z.string().regex(PHONE), z.email().max(254)]),
});
export type SelfTextSetting = z.infer<typeof SelfTextSettingSchema>;
export type SelfTextResult = "sent" | "not-permitted" | "no-messages-account" | "failed";

/** execFile, promisified: rejects with an error carrying the child's stderr, or killed on timeout. */
export type Run = (file: string, args: string[], options: { timeout: number }) => Promise<unknown>;

export type SelfTextDeps = {
  run: Run;
  load(): SelfTextSetting | undefined;
  save(setting: SelfTextSetting): void;
};

// Fixed source: the handle and the text arrive only as argv, so no text can change the script.
const SCRIPT = [
  "on run argv",
  'tell application "Messages"',
  "set candidates to (every account whose service type is iMessage and enabled is true)",
  'if candidates is {} then error "TARS: no iMessage account" number 1',
  "send (item 2 of argv) to participant (item 1 of argv) of (item 1 of candidates)",
  "end tell",
  "end run",
];
// Long enough for the user to read and answer the macOS Automation prompt on the first send.
const TIMEOUT_MS = 60_000;
const TEST_TEXT = "This is a test text from TARS. Nudges you turn on will look like this.";

function resultOf(error: unknown): SelfTextResult {
  const stderr = String((error as { stderr?: unknown }).stderr ?? "");
  // -1743 errAEEventNotPermitted, -1744 errAEEventWouldRequireUserConsent (Apple Event result codes).
  if (/\(-174[34]\)/.test(stderr)) return "not-permitted";
  if (stderr.includes("TARS: no iMessage account")) return "no-messages-account";
  return "failed";
}

export function createSelfText(deps: SelfTextDeps) {
  let lastNudge: SelfTextResult | undefined; // this run only: a failed text is shown, never retried

  async function send(text: string): Promise<SelfTextResult> {
    const setting = deps.load();
    if (!setting) throw new Error("Save your own number first");
    try {
      await deps.run("/usr/bin/osascript", [...SCRIPT.flatMap((line) => ["-e", line]), "--", setting.handle, text], { timeout: TIMEOUT_MS });
      return "sent";
    } catch (error) {
      return resultOf(error);
    }
  }

  return {
    get: () => ({ ...(deps.load() ?? { enabled: false, handle: "" }), ...(lastNudge ? { lastNudge } : {}) }),
    set(setting: SelfTextSetting): SelfTextSetting {
      const parsed = SelfTextSettingSchema.parse(setting);
      deps.save(parsed);
      return parsed;
    },
    /** The user's click: a fixed sentence to the saved handle, on or off. */
    sendTest: () => send(TEST_TEXT),
    /** A nudge the user was just notified about: its own wording, nothing from drafts or sources. */
    async sendNudge(body: string): Promise<SelfTextResult | "off"> {
      if (!deps.load()?.enabled) return "off";
      return (lastNudge = await send(`${body} Open TARS to finish it together.`));
    },
  };
}
