// Companion dictation, cloud side. A signed-in user explicitly begins a short-lived recording
// session; one multipart upload for that session is forwarded to OpenAI speech-to-text and the
// transcript returned verbatim. Audio is never written to storage, tables or logs. A failure
// leaves the session usable for Retry until it expires; success consumes it.
import { v } from "convex/values";
import { z } from "zod";
import { internal } from "./_generated/api";
import { httpAction, internalMutation, internalQuery, mutation } from "./_generated/server";
import { requireOwnerId } from "./lib/auth";

const TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const SESSION_TTL_MS = 15 * 60_000; // a 5-minute recording plus upload and a retry or two
const MAX_AUDIO_BYTES = 20_000_000; // matches DICTATION_LIMITS.maxBytes on the desktop
const MULTIPART_OVERHEAD = 64 * 1024;
const PROVIDER_TIMEOUT_MS = 120_000;
// MediaRecorder / recorder MIME (parameters stripped) → an extension OpenAI accepts; it detects the format by file name.
const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

export const beginDictation = mutation({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);
    const recoveryId = await ctx.db.insert("dictationSessions", { ownerId, expiresAt: Date.now() + SESSION_TTL_MS });
    await ctx.scheduler.runAfter(SESSION_TTL_MS, internal.transcription.consumeSession, { recoveryId });
    return { recoveryId: recoveryId as string };
  },
});

/** The session's ID when it exists, belongs to this owner and has not expired; otherwise null. */
export const liveSession = internalQuery({
  args: { recoveryId: v.string(), ownerId: v.string() },
  handler: async (ctx, { recoveryId, ownerId }) => {
    const id = ctx.db.normalizeId("dictationSessions", recoveryId);
    const session = id === null ? null : await ctx.db.get(id);
    return session !== null && session.ownerId === ownerId && session.expiresAt > Date.now() ? session._id : null;
  },
});

export const consumeSession = internalMutation({
  args: { recoveryId: v.id("dictationSessions") },
  handler: async (ctx, { recoveryId }) => {
    if (await ctx.db.get(recoveryId)) await ctx.db.delete(recoveryId);
  },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fail = (status: number, error: string) => json({ error }, status);
const ProviderResponse = z.object({ text: z.string() });

export const upload = httpAction(async (ctx, request) => {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) return fail(401, "unauthenticated");
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_AUDIO_BYTES + MULTIPART_OVERHEAD) {
    return fail(413, "too_large");
  }

  const form = await request.formData().catch(() => null);
  const recoveryId = form?.get("recoveryId");
  const file = form?.get("file");
  if (typeof recoveryId !== "string" || !(file instanceof Blob)) return fail(400, "bad_request");
  const sessionId = await ctx.runQuery(internal.transcription.liveSession, { recoveryId, ownerId: identity.tokenIdentifier });
  if (sessionId === null) return fail(404, "session_not_found");
  const extension = EXTENSIONS[file.type.split(";")[0]!.trim().toLowerCase()];
  if (extension === undefined) return fail(415, "unsupported_type");
  if (file.size > MAX_AUDIO_BYTES) return fail(413, "too_large");

  // Read per request so a missing value fails this request with a clear code.
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_TRANSCRIBE_MODEL;
  if (!apiKey) return fail(503, "missing_OPENAI_API_KEY");
  if (!model) return fail(503, "missing_OPENAI_TRANSCRIBE_MODEL");

  const body = new FormData();
  body.set("model", model);
  body.set("file", file, `audio.${extension}`);
  let response: Response;
  try {
    response = await fetch(TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    return fail(502, timedOut ? "provider_timeout" : "provider_network");
  }
  if (!response.ok) return fail(502, `provider_http_${response.status}`);
  const parsed = ProviderResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return fail(502, "provider_parse");

  await ctx.runMutation(internal.transcription.consumeSession, { recoveryId: sessionId });
  return json({ text: parsed.data.text });
});
