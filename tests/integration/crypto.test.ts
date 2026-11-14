// @vitest-environment edge-runtime
import { afterEach, describe, expect, test, vi } from "vitest";
import { decryptSecret, encryptSecret } from "../../convex/lib/crypto";

function randomKey(bytes = 32): string {
  const key = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...key));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("server secret encryption", () => {
  test("round trips a provider token", async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", randomKey());
    const sealed = await encryptSecret("xoxb-illustrative-token");
    expect(await decryptSecret(sealed)).toBe("xoxb-illustrative-token");
  });

  test("ciphertext hides the plaintext and differs across encryptions", async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", randomKey());
    const first = await encryptSecret("same-input");
    const second = await encryptSecret("same-input");
    expect(first).not.toContain("same-input");
    expect(atob(first)).not.toContain("same-input");
    expect(first).not.toBe(second);
    // 12-byte IV is carried in the output, so the IVs themselves must differ.
    expect(atob(first).slice(0, 12)).not.toBe(atob(second).slice(0, 12));
  });

  test("decrypting with the wrong key fails", async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", randomKey());
    const sealed = await encryptSecret("secret");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", randomKey());
    await expect(decryptSecret(sealed)).rejects.toThrow();
  });

  test("tampered ciphertext fails authentication", async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", randomKey());
    const raw = atob(await encryptSecret("secret"));
    const flipped = String.fromCharCode(raw.charCodeAt(raw.length - 1) ^ 1);
    const tampered = btoa(raw.slice(0, -1) + flipped);
    await expect(decryptSecret(tampered)).rejects.toThrow();
  });

  test("missing key throws a clear error", async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", undefined);
    await expect(encryptSecret("secret")).rejects.toThrow(/TOKEN_ENCRYPTION_KEY is not set/);
  });

  test("short key throws a clear error", async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", randomKey(16));
    await expect(encryptSecret("secret")).rejects.toThrow(/TOKEN_ENCRYPTION_KEY must be 32 bytes/);
  });
});
