// Quick capture global shortcut. Electron wiring is injected so conflicts can be tested with fakes.
// A registration that fails is reported in the status the renderer shows; it is never silent.
export const DEFAULT_SHORTCUT = "CommandOrControl+Shift+Space";

export type ShortcutStatus = { accelerator: string; registered: boolean; error?: string };

export type ShortcutDeps = {
  /** Electron's globalShortcut.register: false when another app holds it, throws when malformed. */
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  /** Opens the capture surface. Never starts the microphone. */
  onTrigger(): void;
  /** Persists a working choice locally. */
  save(accelerator: string): void;
};

function tryRegister(deps: ShortcutDeps, accelerator: string): string | null {
  try {
    return deps.register(accelerator, deps.onTrigger) ? null : `${accelerator} is in use by another app or macOS`;
  } catch {
    return `${accelerator} is not a valid shortcut`;
  }
}

export function createShortcut(deps: ShortcutDeps, initial: string) {
  const failure = tryRegister(deps, initial);
  let status: ShortcutStatus = failure ? { accelerator: initial, registered: false, error: failure } : { accelerator: initial, registered: true };

  return {
    status: (): ShortcutStatus => status,
    /** Switches to a new accelerator; on failure the previous one stays as it was and the reason is shown. */
    set(accelerator: string): ShortcutStatus {
      if (accelerator === status.accelerator && status.registered) return (status = { accelerator, registered: true });
      const error = tryRegister(deps, accelerator);
      if (error) return (status = { ...status, error });
      if (status.registered) deps.unregister(status.accelerator);
      deps.save(accelerator);
      return (status = { accelerator, registered: true });
    },
    stop(): void {
      if (status.registered) deps.unregister(status.accelerator);
      status = { ...status, registered: false };
    },
  };
}
