// Companion dictation, main process. Audio is spooled encrypted on this Mac before any upload, so
// a failed transcription, crash or failed composer save cannot lose the user's words. Only
// acknowledgeTranscript (text durably in the composer) or discardDictation deletes a spool file.
// Nothing here runs on a timer or retries on its own: every step is a user action.
import { open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DICTATION_LIMITS } from "./dictation-limits";
import type { Cipher } from "./local-store";

export { DICTATION_LIMITS };

// Stop-to-finish latency allowance so a recording stopped exactly at the limit is accepted.
const DURATION_GRACE_MS = 30_000;

export type DictationDeps = {
  cipher: Cipher;
  spoolDir: string;
  /** Opens an explicit, owner-bound cloud recording session (Convex `transcription.beginDictation`). */
  startSession(): Promise<{ recoveryId: string }>;
  /** Uploads one recording for that session and returns the transcript verbatim. */
  transcribe(sessionId: string, audio: Blob): Promise<string>;
  now(): number;
};

export type DictationErrorCode =
  | "not_started"
  | "too_large"
  | "too_long"
  | "unsupported_type"
  | "not_found"
  | "transcription_failed";

export class DictationError extends Error {
  constructor(
    readonly code: DictationErrorCode,
    /** Set when the audio is spooled and can be retried or discarded. */
    readonly recoveryId?: string,
    readonly reason?: string,
  ) {
    super(`Dictation failed: ${code}${reason ? ` (${reason})` : ""}`);
  }
}

export type Recoverable = { recoveryId: string; mime: string; bytes: number; recordedAt: string };

const SpoolSchema = z.strictObject({ mime: z.string(), recordedAt: z.string(), audio: z.string() });
// Recovery IDs arrive from the renderer on retry/discard: only plain IDs, never a path.
const RECOVERY_ID = /^[A-Za-z0-9_-]{8,64}$/;
const AUDIO_MIME = /^audio\/[a-z0-9.+-]+(;.*)?$/i;
const SUFFIX = ".spool";

export function createDictation(deps: DictationDeps) {
  let active: { recoveryId: string; startedAt: number } | null = null;

  const pathOf = (recoveryId: string) => {
    if (!RECOVERY_ID.test(recoveryId)) throw new DictationError("not_found");
    return join(deps.spoolDir, recoveryId + SUFFIX);
  };

  async function writeSpool(recoveryId: string, audio: Uint8Array, mime: string) {
    const record = { mime, recordedAt: new Date(deps.now()).toISOString(), audio: Buffer.from(audio).toString("base64") };
    const target = pathOf(recoveryId);
    const tmp = `${target}.tmp`;
    const file = await open(tmp, "w", 0o600);
    try {
      await file.writeFile(deps.cipher.encrypt(JSON.stringify(record)));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, target);
    const folder = await open(deps.spoolDir, "r"); // make the rename itself durable
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  }

  async function readSpool(recoveryId: string) {
    const raw = await readFile(pathOf(recoveryId)).catch((err: NodeJS.ErrnoException) => {
      throw err.code === "ENOENT" ? new DictationError("not_found") : err;
    });
    const record = SpoolSchema.parse(JSON.parse(deps.cipher.decrypt(raw)));
    return { ...record, audio: Buffer.from(record.audio, "base64") };
  }

  async function upload(sessionId: string, recoveryId: string, audio: Uint8Array, mime: string) {
    try {
      const text = await deps.transcribe(sessionId, new Blob([new Uint8Array(audio)], { type: mime }));
      return { text, recoveryId };
    } catch (err) {
      throw new DictationError("transcription_failed", recoveryId, err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(recoveryId: string) {
    await unlink(pathOf(recoveryId)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
  }

  return {
    /** Call when the user presses Record (never on the shortcut alone). */
    async beginDictation(): Promise<void> {
      const { recoveryId } = await deps.startSession();
      active = { recoveryId, startedAt: deps.now() };
    },

    /** Call when the user stops. Returns text for the editable composer; it saves and sends nothing itself. */
    async finishDictation(audio: Uint8Array, mime: string): Promise<{ text: string; recoveryId: string }> {
      if (active === null) throw new DictationError("not_started");
      if (!AUDIO_MIME.test(mime)) throw new DictationError("unsupported_type");
      if (audio.byteLength > DICTATION_LIMITS.maxBytes) throw new DictationError("too_large");
      if (deps.now() - active.startedAt > DICTATION_LIMITS.maxDurationMs + DURATION_GRACE_MS) {
        throw new DictationError("too_long");
      }
      const { recoveryId } = active;
      active = null;
      await writeSpool(recoveryId, audio, mime);
      return upload(recoveryId, recoveryId, audio, mime);
    },

    /** User-initiated Retry. Opens a fresh session: the original may have expired (e.g. after restart). */
    async retryDictation(recoveryId: string): Promise<{ text: string; recoveryId: string }> {
      const { audio, mime } = await readSpool(recoveryId);
      const { recoveryId: sessionId } = await deps.startSession();
      return upload(sessionId, recoveryId, audio, mime);
    },

    async discardDictation(recoveryId: string): Promise<void> {
      await readSpool(recoveryId);
      await remove(recoveryId);
    },

    /** Call only after the composer's text is durably saved. */
    async acknowledgeTranscript(recoveryId: string): Promise<void> {
      await remove(recoveryId);
    },

    /** Recordings not yet acknowledged or discarded, e.g. after a crash or failed transcription. */
    async listRecoverable(): Promise<Recoverable[]> {
      const names = (await readdir(deps.spoolDir)).filter((name) => name.endsWith(SUFFIX));
      const found = await Promise.all(
        names.map(async (name) => {
          const recoveryId = name.slice(0, -SUFFIX.length);
          const { mime, recordedAt, audio } = await readSpool(recoveryId);
          return { recoveryId, mime, bytes: audio.byteLength, recordedAt };
        }),
      );
      return found.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    },
  };
}

export class TranscriptionError extends Error {
  constructor(readonly code: string) {
    super(`Transcription failed: ${code}`);
  }
}

const TranscriptSchema = z.object({ text: z.string() });
const ErrorSchema = z.object({ error: z.string() });

/** The real `transcribe` dependency: a multipart POST to the Convex HTTP action with the current ID token. */
export function createTranscriptionUploader(config: { siteUrl: string; getIdToken(): Promise<string | null> }) {
  return async (sessionId: string, audio: Blob): Promise<string> => {
    const token = await config.getIdToken();
    if (!token) throw new TranscriptionError("unauthenticated");
    const body = new FormData();
    body.set("recoveryId", sessionId);
    body.set("file", audio, "audio");
    let response: Response;
    try {
      response = await fetch(`${config.siteUrl}/transcription`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body,
      });
    } catch {
      throw new TranscriptionError("network");
    }
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new TranscriptionError(ErrorSchema.safeParse(json).data?.error ?? `http_${response.status}`);
    const parsed = TranscriptSchema.safeParse(json);
    if (!parsed.success) throw new TranscriptionError("parse");
    return parsed.data.text;
  };
}
