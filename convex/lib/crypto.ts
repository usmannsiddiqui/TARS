// Server-only encryption for secrets at rest (e.g. provider tokens). AES-256-GCM via
// WebCrypto so it runs in the default Convex runtime. Output: base64(iv || ciphertext+tag).
// Never return the plaintext or the sealed value from a public query.

const IV_BYTES = 12;
const KEY_BYTES = 32;

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function loadKey(): Promise<CryptoKey> {
  const encoded = process.env.TOKEN_ENCRYPTION_KEY;
  if (!encoded) {
    throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  }
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64(encoded);
  } catch {
    throw new Error("TOKEN_ENCRYPTION_KEY must be base64");
  }
  if (raw.length !== KEY_BYTES) {
    throw new Error(`TOKEN_ENCRYPTION_KEY must be ${KEY_BYTES} bytes (base64-encoded)`);
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await loadKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const sealed = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  sealed.set(iv, 0);
  sealed.set(new Uint8Array(ciphertext), IV_BYTES);
  return toBase64(sealed);
}

/** Throws if the key is wrong or the payload was modified (GCM authentication fails). */
export async function decryptSecret(sealed: string): Promise<string> {
  const key = await loadKey();
  const bytes = fromBase64(sealed);
  const iv = bytes.slice(0, IV_BYTES);
  const ciphertext = bytes.slice(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
