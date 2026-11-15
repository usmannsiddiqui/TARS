// Quick capture shortcut with a fake OS registry: no real global shortcut is registered.
import { describe, expect, it } from "vitest";
import { createShortcut, DEFAULT_SHORTCUT } from "../../apps/desktop/src/main/shortcut";

function fakeOs(taken: string[] = [], invalid: string[] = []) {
  const registered = new Map<string, () => void>();
  const saved: string[] = [];
  let triggers = 0;
  const deps = {
    register(accelerator: string, callback: () => void) {
      if (invalid.includes(accelerator)) throw new Error("conversion failure");
      if (taken.includes(accelerator) || registered.has(accelerator)) return false;
      registered.set(accelerator, callback);
      return true;
    },
    unregister: (accelerator: string) => void registered.delete(accelerator),
    onTrigger: () => void triggers++,
    save: (accelerator: string) => void saved.push(accelerator),
  };
  return { deps, registered, saved, triggers: () => triggers };
}

describe("quick capture shortcut", () => {
  it("registers the saved (or default) accelerator and opens capture when pressed", () => {
    const os = fakeOs();
    const shortcut = createShortcut(os.deps, DEFAULT_SHORTCUT);
    expect(DEFAULT_SHORTCUT).toBe("CommandOrControl+Shift+Space");
    expect(shortcut.status()).toEqual({ accelerator: "CommandOrControl+Shift+Space", registered: true });
    os.registered.get(DEFAULT_SHORTCUT)?.();
    expect(os.triggers()).toBe(1);
  });

  it("shortcut_conflict_is_visible: a taken accelerator at start is reported, never silent", () => {
    const os = fakeOs([DEFAULT_SHORTCUT]);
    const status = createShortcut(os.deps, DEFAULT_SHORTCUT).status();
    expect(status.registered).toBe(false);
    expect(status.error).toMatch(/in use by another app/);
  });

  it("changing to a taken or invalid accelerator keeps the working one and says why", () => {
    const os = fakeOs(["Alt+Shift+K"], ["Alt+Shift+Nope"]);
    const shortcut = createShortcut(os.deps, DEFAULT_SHORTCUT);
    expect(shortcut.set("Alt+Shift+K")).toMatchObject({ accelerator: DEFAULT_SHORTCUT, registered: true, error: expect.stringMatching(/Alt\+Shift\+K.*in use/) });
    expect(shortcut.set("Alt+Shift+Nope")).toMatchObject({ accelerator: DEFAULT_SHORTCUT, registered: true, error: expect.stringMatching(/not a valid shortcut/) });
    expect([...os.registered.keys()]).toEqual([DEFAULT_SHORTCUT]);
    expect(os.saved).toEqual([]);
  });

  it("a successful change replaces the old registration and persists the choice", () => {
    const os = fakeOs();
    const shortcut = createShortcut(os.deps, DEFAULT_SHORTCUT);
    expect(shortcut.set("Alt+Shift+J")).toEqual({ accelerator: "Alt+Shift+J", registered: true });
    expect([...os.registered.keys()]).toEqual(["Alt+Shift+J"]);
    expect(os.saved).toEqual(["Alt+Shift+J"]);
    shortcut.stop();
    expect(os.registered.size).toBe(0);
  });
});
