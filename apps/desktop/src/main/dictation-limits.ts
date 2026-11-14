// Its own module so the sandboxed preload can expose the limits without bundling any Node code.
/** Shown before capture; the renderer stops recording at these, main rejects anything beyond them. */
export const DICTATION_LIMITS = { maxBytes: 20_000_000, maxDurationMs: 5 * 60_000 } as const;
