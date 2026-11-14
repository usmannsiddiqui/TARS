// Durable, encrypted local capture queue and evidence outbox (SQLite). Main process only.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { z } from "zod";
import {
  CaptureInputSchema,
  EvidenceSchema,
  SourceGrantSchema,
  type Artifact,
  type ArtifactId,
  type CaptureInput,
  type CaptureReceipt,
  type Evidence,
  type OwnerId,
  type SourceGrant,
  type SourceId,
} from "@companion/domain";
import { ArtifactSchema } from "@companion/domain/artifacts";

/** A selected local source as persisted; mirroredVersion is the grant version the cloud last confirmed (null: never sent). */
export type LocalGrantRecord = { grant: SourceGrant; mirroredVersion: number | null };
const LocalGrantRecordSchema = z.strictObject({ grant: SourceGrantSchema, mirroredVersion: z.number().int().nullable() });

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
  /** Buffers source evidence until the cloud accepts it. False when this source revision is already queued. */
  enqueueEvidence(evidence: Evidence, ownerId: OwnerId): Promise<boolean>;
  loadOutbox(ownerId: OwnerId): Promise<Evidence[]>;
  /** The cloud stored (or already had) this record: drop it from the outbox and never queue it again. */
  markSynced(evidence: Evidence, ownerId: OwnerId): Promise<void>;
  /** Upserts a grant, encrypted; it holds the selected path. */
  saveGrant(record: LocalGrantRecord): Promise<void>;
  loadGrants(ownerId: OwnerId): Promise<LocalGrantRecord[]>;
  /** Drops every unsynced record of a source (revocation). Returns how many were discarded. */
  discardSource(ownerId: OwnerId, sourceId: SourceId): Promise<number>;
  /**
   * Durably records the user's latest edit of an artifact, encrypted; resolves only after commit.
   * `artifact.revision` is the cloud revision the text was edited from (see reconcileDraft).
   */
  saveDraft(artifact: Artifact, ownerId: OwnerId): Promise<void>;
  loadDraft(artifactId: ArtifactId, ownerId: OwnerId): Promise<Artifact | null>;
  close(): void;
};

const SUMMARY_LENGTH = 80;

// Dedupe on externalId + version without writing note paths to disk in plaintext.
const revisionKeyOf = (evidence: Evidence) =>
  createHash("sha256").update(JSON.stringify([evidence.externalId, evidence.version])).digest("hex");

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
  db.exec(`CREATE TABLE IF NOT EXISTS evidence_outbox (
    owner_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    revision_key TEXT NOT NULL,
    payload BLOB NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, source_id, revision_key)
  ) STRICT`);

  db.exec(`CREATE TABLE IF NOT EXISTS evidence_sent (
    owner_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    revision_key TEXT NOT NULL,
    PRIMARY KEY (owner_id, source_id, revision_key)
  ) STRICT`);
  db.exec(`CREATE TABLE IF NOT EXISTS source_grants (
    owner_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    payload BLOB NOT NULL,
    PRIMARY KEY (owner_id, source_id)
  ) STRICT`);

  db.exec(`CREATE TABLE IF NOT EXISTS artifact_drafts (
    owner_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    payload BLOB NOT NULL,
    PRIMARY KEY (owner_id, artifact_id)
  ) STRICT`);

  const insert = db.prepare("INSERT INTO captures (id, owner_id, payload, created_at) VALUES (?, ?, ?, ?)");
  const selectByOwner = db.prepare<[string], { payload: Buffer }>(
    "SELECT payload FROM captures WHERE owner_id = ? ORDER BY created_at, rowid",
  );

  const insertEvidence = db.prepare(
    `INSERT OR IGNORE INTO evidence_outbox (owner_id, source_id, revision_key, payload, created_at)
     SELECT @owner, @source, @key, @payload, @createdAt WHERE NOT EXISTS
       (SELECT 1 FROM evidence_sent WHERE owner_id = @owner AND source_id = @source AND revision_key = @key)`,
  );
  const deleteQueued = db.prepare("DELETE FROM evidence_outbox WHERE owner_id = ? AND source_id = ? AND revision_key = ?");
  const insertSent = db.prepare("INSERT OR IGNORE INTO evidence_sent (owner_id, source_id, revision_key) VALUES (?, ?, ?)");
  const upsertGrant = db.prepare(
    "INSERT INTO source_grants (owner_id, source_id, payload) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET payload = excluded.payload",
  );
  const selectGrants = db.prepare<[string], { payload: Buffer }>(
    "SELECT payload FROM source_grants WHERE owner_id = ? ORDER BY rowid",
  );
  const selectOutbox = db.prepare<[string], { payload: Buffer }>(
    "SELECT payload FROM evidence_outbox WHERE owner_id = ? ORDER BY created_at, rowid",
  );
  const deleteSource = db.prepare("DELETE FROM evidence_outbox WHERE owner_id = ? AND source_id = ?");
  const upsertDraft = db.prepare(
    "INSERT INTO artifact_drafts (owner_id, artifact_id, payload) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET payload = excluded.payload",
  );
  const selectDraft = db.prepare<[string, string], { payload: Buffer }>(
    "SELECT payload FROM artifact_drafts WHERE owner_id = ? AND artifact_id = ?",
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
    async enqueueEvidence(input, ownerId) {
      const evidence = EvidenceSchema.parse(input);
      if (evidence.ownerId !== ownerId) throw new Error("Evidence owner does not match the signed-in owner");
      const payload = cipher.encrypt(JSON.stringify(evidence));
      const row = { owner: ownerId, source: evidence.sourceId, key: revisionKeyOf(evidence), payload, createdAt: new Date().toISOString() };
      return insertEvidence.run(row).changes === 1;
    },
    async loadOutbox(ownerId) {
      return selectOutbox.all(ownerId).map((row) => EvidenceSchema.parse(JSON.parse(cipher.decrypt(row.payload))));
    },
    async markSynced(evidence, ownerId) {
      if (evidence.ownerId !== ownerId) throw new Error("Evidence owner does not match the signed-in owner");
      const key = revisionKeyOf(evidence);
      db.transaction(() => {
        deleteQueued.run(ownerId, evidence.sourceId, key);
        insertSent.run(ownerId, evidence.sourceId, key);
      })();
    },
    async saveGrant(input) {
      const record = LocalGrantRecordSchema.parse(input);
      upsertGrant.run(record.grant.ownerId, record.grant.id, cipher.encrypt(JSON.stringify(record)));
    },
    async loadGrants(ownerId) {
      return selectGrants.all(ownerId).map((row) => LocalGrantRecordSchema.parse(JSON.parse(cipher.decrypt(row.payload))));
    },
    async discardSource(ownerId, sourceId) {
      return deleteSource.run(ownerId, sourceId).changes;
    },
    async saveDraft(input, ownerId) {
      const artifact = ArtifactSchema.parse(input);
      if (artifact.ownerId !== ownerId) throw new Error("Artifact owner does not match the signed-in owner");
      // synchronous = FULL: the write is on disk when run() returns, so the edit is acknowledged only after that.
      upsertDraft.run(ownerId, artifact.id, cipher.encrypt(JSON.stringify(artifact)));
    },
    async loadDraft(artifactId, ownerId) {
      const row = selectDraft.get(ownerId, artifactId);
      return row === undefined ? null : ArtifactSchema.parse(JSON.parse(cipher.decrypt(row.payload)));
    },
    close() {
      db.close();
    },
  };
}
