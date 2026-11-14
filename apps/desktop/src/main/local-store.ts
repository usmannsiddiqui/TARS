// Durable, encrypted local capture queue (SQLite). Main process only.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { CaptureInputSchema, type CaptureInput, type CaptureReceipt, type OwnerId } from "@companion/domain";

/** Encrypts payloads at rest. Injected so the store runs on plain Node in tests. */
export type Cipher = { encrypt(plain: string): Buffer; decrypt(buf: Buffer): string };

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM with a 32-byte data key. In the app the key itself is wrapped by OS-protected storage. */
export function aesGcmCipher(key: Buffer): Cipher {
  if (key.length !== 32) throw new Error("Data key must be 32 bytes");
  return {
    encrypt(plain) {
      const iv = randomBytes(IV_BYTES);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]);
    },
    decrypt(buf) {
      const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, IV_BYTES));
      d.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([d.update(buf.subarray(IV_BYTES + TAG_BYTES)), d.final()]).toString("utf8");
    },
  };
}

export type LocalStore = {
  saveCapture(input: CaptureInput, ownerId: OwnerId): Promise<CaptureReceipt>;
  loadPending(ownerId: OwnerId): Promise<CaptureInput[]>;
  close(): void;
};

const SUMMARY_LENGTH = 80;

export function openLocalStore(dbPath: string, cipher: Cipher): LocalStore {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.exec(`CREATE TABLE IF NOT EXISTS captures (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    payload BLOB NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT`);

  const insert = db.prepare("INSERT INTO captures (id, owner_id, payload, created_at) VALUES (?, ?, ?, ?)");
  const selectByOwner = db.prepare<[string], { payload: Buffer }>(
    "SELECT payload FROM captures WHERE owner_id = ? ORDER BY created_at, rowid",
  );

  return {
    async saveCapture(input, ownerId) {
      const capture = CaptureInputSchema.parse(input);
      const id = randomUUID();
      // Runs in a transaction: a receipt is only produced after the commit returns.
      db.transaction(() => {
        insert.run(id, ownerId, cipher.encrypt(JSON.stringify(capture)), new Date().toISOString());
      })();
      return {
        id,
        saved: true,
        summary: capture.text.slice(0, SUMMARY_LENGTH),
        ...(capture.projectHint ? { projectId: capture.projectHint } : {}),
      };
    },
    async loadPending(ownerId) {
      return selectByOwner
        .all(ownerId)
        .map((row) => CaptureInputSchema.parse(JSON.parse(cipher.decrypt(row.payload))));
    },
    close() {
      db.close();
    },
  };
}
