// @vitest-environment edge-runtime
// Synthetic audio bytes only: no microphone, no live provider. OpenAI is a stubbed `fetch`.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import {
  createDictation,
  createTranscriptionUploader,
  DICTATION_LIMITS,
  DictationError,
  type DictationDeps,
} from "../../apps/desktop/src/main/dictation";
import { aesGcmCipher, type Cipher } from "../../apps/desktop/src/main/local-store";
import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { makeOwners } from "../fixtures";

const modules = import.meta.glob("../../convex/**/*.*s");

// A recognisable byte pattern standing in for recorded speech.
const MARKER = "SYNTHETIC-AUDIO-MARKER-0123456789";
const audio = () => new TextEncoder().encode(`RIFF....WAVE${MARKER}${"x".repeat(2048)}`);
const sameBytes = async (blob: Blob, expected: Uint8Array) =>
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(expected);

let dir: string;
let cipher: Cipher;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "companion-dictation-"));
  cipher = aesGcmCipher(randomBytes(32));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function desktop(overrides: { transcribe?: Mock<DictationDeps["transcribe"]> } = {}) {
  let n = 0;
  let clock = 1_763_150_400_000;
  const deps = {
    cipher,
    spoolDir: dir,
    startSession: vi.fn(async () => ({ recoveryId: `session${String(++n).padStart(12, "0")}` })),
    transcribe: overrides.transcribe ?? vi.fn<DictationDeps["transcribe"]>(async () => "the idea, in my words"),
    now: () => clock,
  };
  return { deps, dictation: createDictation(deps), advance: (ms: number) => (clock += ms) };
}

describe("desktop dictation spool", () => {
  test("failed_persistence_keeps_audio_recoverable", async () => {
    const { dictation, deps } = desktop();
    await dictation.beginDictation();
    const { text, recoveryId } = await dictation.finishDictation(audio(), "audio/webm;codecs=opus");
    expect(text).toBe("the idea, in my words");

    // The composer's durable save fails, so the caller never acknowledges.
    const saveComposer = async () => {
      throw new Error("disk full");
    };
    await expect(saveComposer()).rejects.toThrow("disk full");

    expect((await dictation.listRecoverable()).map((r) => r.recoveryId)).toEqual([recoveryId]);
    await dictation.retryDictation(recoveryId);
    await sameBytes(deps.transcribe.mock.calls[1]![1], audio());
  });

  test("restart_recovers_unsaved_capture", async () => {
    const first = desktop({ transcribe: vi.fn<DictationDeps["transcribe"]>(async () => Promise.reject(new Error("network"))) });
    await first.dictation.beginDictation();
    const failed = await first.dictation.finishDictation(audio(), "audio/webm").catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(DictationError);
    const recoveryId = (failed as DictationError).recoveryId!;

    // A new module instance over the same spool directory, as after a crash or restart.
    const second = desktop();
    const listed = await second.dictation.listRecoverable();
    expect(listed).toEqual([
      { recoveryId, mime: "audio/webm", bytes: audio().byteLength, recordedAt: expect.any(String) },
    ]);
    const retried = await second.dictation.retryDictation(recoveryId);
    expect(retried).toEqual({ text: "the idea, in my words", recoveryId });
    await sameBytes(second.deps.transcribe.mock.calls[0]![1], audio());
    // Retry opens a fresh explicit session: the original may have expired while the app was closed.
    expect(second.deps.startSession).toHaveBeenCalledOnce();

    await second.dictation.acknowledgeTranscript(recoveryId);
    expect(await second.dictation.listRecoverable()).toEqual([]);
  });

  test("failed transcription keeps audio with Retry and Discard", async () => {
    const transcribe = vi.fn<DictationDeps["transcribe"]>(async () => Promise.reject(new Error("provider_http_500")));
    const { dictation } = desktop({ transcribe });
    await dictation.beginDictation();
    const err = (await dictation.finishDictation(audio(), "audio/webm").catch((e: unknown) => e)) as DictationError;
    expect(err).toMatchObject({ code: "transcription_failed", reason: "provider_http_500" });
    expect(err.recoveryId).toMatch(/^session/);

    await expect(dictation.retryDictation(err.recoveryId!)).rejects.toMatchObject({ code: "transcription_failed" });
    expect(await dictation.listRecoverable()).toHaveLength(1);

    await dictation.discardDictation(err.recoveryId!);
    expect(await dictation.listRecoverable()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    await expect(dictation.retryDictation(err.recoveryId!)).rejects.toMatchObject({ code: "not_found" });
  });

  test("spool is written before upload starts and is not plaintext audio", async () => {
    const seenAtUpload: string[][] = [];
    const { dictation } = desktop({
      transcribe: vi.fn<DictationDeps["transcribe"]>(async () => {
        seenAtUpload.push(readdirSync(dir));
        return "ok";
      }),
    });
    await dictation.beginDictation();
    const { recoveryId } = await dictation.finishDictation(audio(), "audio/webm");
    expect(seenAtUpload).toEqual([[`${recoveryId}.spool`]]);

    const bytes = readFileSync(join(dir, `${recoveryId}.spool`));
    expect(bytes.includes(Buffer.from(MARKER))).toBe(false);
    expect(bytes.includes(Buffer.from(Buffer.from(MARKER).toString("base64").slice(0, 16)))).toBe(false);
  });

  test("oversize, overlong, unbegun and non-audio input is rejected before spool or upload", async () => {
    const { dictation, deps, advance } = desktop();
    await expect(dictation.finishDictation(audio(), "audio/webm")).rejects.toMatchObject({ code: "not_started" });

    await dictation.beginDictation();
    const tooBig = new Uint8Array(DICTATION_LIMITS.maxBytes + 1);
    await expect(dictation.finishDictation(tooBig, "audio/webm")).rejects.toMatchObject({ code: "too_large" });
    await expect(dictation.finishDictation(audio(), "text/html")).rejects.toMatchObject({ code: "unsupported_type" });
    advance(DICTATION_LIMITS.maxDurationMs + 60_000);
    await expect(dictation.finishDictation(audio(), "audio/webm")).rejects.toMatchObject({ code: "too_long" });

    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
    await expect(dictation.discardDictation("../../etc/passwd")).rejects.toMatchObject({ code: "not_found" });
  });
});

// ---- Cloud: the multipart HTTP action behind the desktop uploader.
const SITE = "https://companion-test.convex.site";
const PROVIDER = "https://api.openai.com/v1/audio/transcriptions";
const PROVIDER_TEXT = "  um, so — the idea is: pets that *remind* you, not nag.  ";

function cloud() {
  vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
  vi.stubEnv("OPENAI_TRANSCRIBE_MODEL", "gpt-transcribe");
  const t = convexTest(schema, modules);
  const { alice, bob } = makeOwners();
  const asAlice = t.withIdentity({ tokenIdentifier: alice.ownerId, subject: "alice" });
  const asBob = t.withIdentity({ tokenIdentifier: bob.ownerId, subject: "bob" });
  const provider = vi.fn<(init: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ text: PROVIDER_TEXT, languages: [] })));
  // The desktop uploader's request reaches the Convex router as the signed-in caller; the
  // action's own call to OpenAI reaches the stub.
  let caller = asAlice;
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href === PROVIDER) return provider(init!);
    if (href.startsWith(SITE)) return caller.fetch(href.slice(SITE.length), init);
    throw new Error(`unexpected fetch ${href}`);
  });
  const upload = createTranscriptionUploader({ siteUrl: SITE, getIdToken: async () => "id-token-not-real" });
  return { t, asAlice, asBob, provider, upload, actAs: (who: typeof asAlice) => (caller = who) };
}

const form = (recoveryId: string, blob: Blob) => {
  const body = new FormData();
  body.set("recoveryId", recoveryId);
  body.set("file", blob, "audio.webm");
  return body;
};

async function noAudioStored(t: ReturnType<typeof convexTest>) {
  const dump = await t.run(async (ctx) => {
    const rows: unknown[] = [];
    for (const table of Object.keys(schema.tables)) rows.push(await ctx.db.query(table as never).collect());
    return { rows: JSON.stringify(rows), files: (await ctx.db.system.query("_storage").collect()).length };
  });
  expect(dump.rows).not.toContain(MARKER);
  expect(dump.files).toBe(0);
}

describe("cloud transcription endpoint", () => {
  test("success returns the provider's text unchanged and consumes the session", async () => {
    const { t, asAlice, provider, upload } = cloud();
    const { recoveryId } = await asAlice.mutation(api.transcription.beginDictation, {});
    const text = await upload(recoveryId, new Blob([audio()], { type: "audio/webm;codecs=opus" }));
    expect(text).toBe(PROVIDER_TEXT);

    const sent = provider.mock.calls[0]![0];
    expect(new Headers(sent.headers).get("Authorization")).toBe("Bearer test-key-not-real");
    const sentForm = sent.body as FormData;
    expect(sentForm.get("model")).toBe("gpt-transcribe");
    expect((sentForm.get("file") as File).name).toBe("audio.webm");
    await sameBytes(sentForm.get("file") as File, audio());

    // Single use: the same recording session cannot transcribe a second upload.
    await expect(upload(recoveryId, new Blob([audio()], { type: "audio/webm" }))).rejects.toMatchObject({
      code: "session_not_found",
    });
    await noAudioStored(t);
  });

  test("unauthenticated callers are rejected", async () => {
    const { t, asAlice, provider } = cloud();
    await expect(t.mutation(api.transcription.beginDictation, {})).rejects.toThrow("Not authenticated");
    const { recoveryId } = await asAlice.mutation(api.transcription.beginDictation, {});
    const res = await t.fetch("/transcription", { method: "POST", body: form(recoveryId, new Blob([audio()], { type: "audio/webm" })) });
    expect(res.status).toBe(401);
    expect(provider).not.toHaveBeenCalled();
  });

  test("another owner's recoveryId is rejected and stays usable by its owner", async () => {
    const { asAlice, asBob, provider, upload, actAs } = cloud();
    const { recoveryId } = await asAlice.mutation(api.transcription.beginDictation, {});
    actAs(asBob);
    await expect(upload(recoveryId, new Blob([audio()], { type: "audio/webm" }))).rejects.toMatchObject({
      code: "session_not_found",
    });
    expect(provider).not.toHaveBeenCalled();
    actAs(asAlice);
    expect(await upload(recoveryId, new Blob([audio()], { type: "audio/webm" }))).toBe(PROVIDER_TEXT);
  });

  test("wrong MIME, oversize and expired sessions are rejected before the provider", async () => {
    const { t, asAlice, provider, upload } = cloud();
    const { recoveryId } = await asAlice.mutation(api.transcription.beginDictation, {});
    await expect(upload(recoveryId, new Blob([audio()], { type: "text/html" }))).rejects.toMatchObject({
      code: "unsupported_type",
    });
    const big = new Blob([new Uint8Array(DICTATION_LIMITS.maxBytes + 1)], { type: "audio/webm" });
    await expect(upload(recoveryId, big)).rejects.toMatchObject({ code: "too_large" });

    await t.run(async (ctx) => ctx.db.patch(recoveryId as never, { expiresAt: Date.now() - 1 }));
    await expect(upload(recoveryId, new Blob([audio()], { type: "audio/webm" }))).rejects.toMatchObject({
      code: "session_not_found",
    });
    expect(provider).not.toHaveBeenCalled();
  });

  test("missing key gives a clear error, stores nothing and leaves the session for Retry", async () => {
    const { t, asAlice, provider, upload } = cloud();
    const { recoveryId } = await asAlice.mutation(api.transcription.beginDictation, {});
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(upload(recoveryId, new Blob([audio()], { type: "audio/webm" }))).rejects.toMatchObject({
      code: "missing_OPENAI_API_KEY",
    });
    expect(provider).not.toHaveBeenCalled();
    await noAudioStored(t);

    vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
    expect(await upload(recoveryId, new Blob([audio()], { type: "audio/webm" }))).toBe(PROVIDER_TEXT);
  });
});
