// Registry additions wired in this pass: observation grants, retained-observation deletion, log-note designation.
// Temp folders only; the watcher is a fake so no file events or helper processes are involved.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectIdSchema, type SourceGrant } from "@companion/domain";
import type { LocalGrantRecord } from "../../apps/desktop/src/main/local-store";
import { createLocalSources, type WatchHandle } from "../../apps/desktop/src/main/source-watch";
import { makeOwners } from "../fixtures";

let vault: string;
let outside: string;
beforeEach(() => {
  vault = realpathSync(mkdtempSync(join(tmpdir(), "tars-registry-vault-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "tars-registry-outside-")));
  writeFileSync(join(vault, "Outcomes.md"), "# Outcomes\n");
  writeFileSync(join(outside, "Elsewhere.md"), "x\n");
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const handle = (): WatchHandle =>
  Object.assign(() => {}, {
    status: () => ({ freshness: "current" as const, files: 0, issues: [] }),
    ready: Promise.resolve(),
    reconcile: async () => {},
  });

function setup(picks: (string | null)[]) {
  const started: SourceGrant[] = [];
  const saved: LocalGrantRecord[] = [];
  const discarded: string[] = [];
  let changes = 0;
  const sources = createLocalSources({
    pickPath: async () => picks.shift() ?? null,
    start: async (grant) => {
      started.push(grant);
      return handle();
    },
    store: {
      enqueueEvidence: async () => true,
      discardSource: async (_owner, sourceId) => {
        discarded.push(sourceId);
        return 0;
      },
      saveGrant: async (record) => void saved.push(record),
      loadGrants: async () => [],
    },
    onChange: () => void changes++,
  });
  return { sources, started, saved, discarded, changes: () => changes };
}
const projectIds = [ProjectIdSchema.parse("project-avt")];

describe("source registry wiring", () => {
  it("observation grants hold exactly the user's selectors and only one can be active", async () => {
    const { alice } = makeOwners();
    const s = setup([]);
    const view = await s.sources.observe(alice.ownerId, { selectors: ["com.apple.Notes"], projectIds });
    expect(view).toMatchObject({ kind: "observation", state: "active", cloudProcessing: false });
    expect(s.started[0]).toMatchObject({ kind: "observation", selectors: ["com.apple.Notes"], writeTargets: [], read: true });
    await expect(s.sources.observe(alice.ownerId, { selectors: ["com.apple.TextEdit"], projectIds })).rejects.toThrow(/one observation/);

    await s.sources.pause(alice.ownerId, view.id);
    await expect(s.sources.observe(alice.ownerId, { selectors: ["com.apple.TextEdit"], projectIds })).resolves.toMatchObject({ state: "active" });
  });

  it("deleting retained observations discards that source's local outbox, and only for an observation source of this owner", async () => {
    const { alice, bob } = makeOwners();
    const s = setup([vault]);
    const observed = await s.sources.observe(alice.ownerId, { selectors: ["com.apple.Notes"], projectIds });
    const notes = await s.sources.choose(alice.ownerId, { kind: "obsidian", projectIds });
    await expect(s.sources.deleteRetained(bob.ownerId, observed.id)).rejects.toThrow("Unknown source");
    await expect(s.sources.deleteRetained(alice.ownerId, notes!.id)).rejects.toThrow("Unknown source");
    await s.sources.deleteRetained(alice.ownerId, observed.id);
    expect(s.discarded).toEqual([observed.id]);
  });

  it("designating the log note records it as the grant's write target, bumps the version and returns only an opaque id", async () => {
    const { alice } = makeOwners();
    const note = join(vault, "Outcomes.md");
    const s = setup([vault, note]);
    const notes = await s.sources.choose(alice.ownerId, { kind: "obsidian", projectIds });
    const designated = await s.sources.designateLog(alice.ownerId, notes!.id);
    expect(designated).toMatchObject({ sourceId: notes!.id, name: "Outcomes.md", target: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(JSON.stringify(designated)).not.toContain(vault);
    expect(s.saved.at(-1)?.grant).toMatchObject({ writeTargets: [note], version: notes!.version + 1 });
    expect(s.started.at(-1)?.writeTargets).toEqual([note]); // restarted so the watcher skips the log note
    expect(s.discarded).toEqual([notes!.id]); // evidence of the old version is not sent under the new one
  });

  it("a note outside the granted folder, a non-Markdown file or a cancelled dialog designates nothing", async () => {
    const { alice } = makeOwners();
    writeFileSync(join(vault, "image.png"), "");
    const s = setup([vault, join(outside, "Elsewhere.md"), join(vault, "image.png"), null]);
    const notes = await s.sources.choose(alice.ownerId, { kind: "obsidian", projectIds });
    await expect(s.sources.designateLog(alice.ownerId, notes!.id)).rejects.toThrow(/inside the selected notes folder/);
    await expect(s.sources.designateLog(alice.ownerId, notes!.id)).rejects.toThrow(/Markdown/);
    expect(await s.sources.designateLog(alice.ownerId, notes!.id)).toBeNull();
    expect(s.saved.at(-1)?.grant.writeTargets).toEqual([]);
  });
});
