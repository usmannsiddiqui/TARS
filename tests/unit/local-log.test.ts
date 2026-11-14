// Temp folders only: never the user's vault.
import { mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { OwnerId, ProjectId, SourceGrant, SourceId } from "@companion/domain";
import { appendLocalLog } from "../../apps/desktop/src/main/local-log";
import { markdownReader, scanSelected } from "../../apps/desktop/src/main/source-watch";

let vault: string;
let outside: string;
let note: string;

beforeEach(async () => {
  vault = await realpath(await mkdtemp(join(tmpdir(), "tars-log-vault-")));
  outside = await realpath(await mkdtemp(join(tmpdir(), "tars-log-outside-")));
  note = join(vault, "Outcomes.md");
  await writeFile(note, "# Outcomes\n\nWritten by me.\n");
});
afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const grant = (writeTargets: string[] = [note]): SourceGrant => ({
  id: "source-obsidian" as SourceId,
  ownerId: "owner-alice" as OwnerId,
  kind: "obsidian",
  selectors: [vault],
  projectIds: ["project-avt" as ProjectId],
  read: true,
  writeTargets,
  cloudProcessing: true,
  version: 1,
  state: "active",
});
const request = (notePath = note) => ({ notePath, marker: "tars-log-a1", entry: "Sent mail to bob. [tars-log-a1]" });

describe("local outcome log", () => {
  test("appends after the user's text and reads it back", async () => {
    expect(await appendLocalLog(grant(), request())).toEqual({ result: "written" });
    const text = await readFile(note, "utf8");
    expect(text.startsWith("# Outcomes\n\nWritten by me.\n")).toBe(true);
    expect(text).toContain("tars-log-a1");
  });

  test("marker makes a repeated append a no-op", async () => {
    await appendLocalLog(grant(), request());
    expect(await appendLocalLog(grant(), request())).toEqual({ result: "written" });
    expect((await readFile(note, "utf8")).split("tars-log-a1").length - 1).toBe(1);
  });

  test("a concurrent change detected by hash is not overwritten", async () => {
    const result = await appendLocalLog(grant(), request(), {
      beforeReplace: () => writeFile(note, "# Outcomes\n\nWritten by me.\nAnd a line I just typed.\n"),
    });
    expect(result.result).toBe("failed");
    const text = await readFile(note, "utf8");
    expect(text).toContain("And a line I just typed.");
    expect(text).not.toContain("tars-log-a1");
  });

  test("atomic replace: no temp file is left and the note is whole", async () => {
    await appendLocalLog(grant(), request());
    expect(await readdir(vault)).toEqual(["Outcomes.md"]);
  });

  test("a path outside the granted root is denied, also through a symlink", async () => {
    const foreign = join(outside, "Elsewhere.md");
    await writeFile(foreign, "not yours\n");
    expect((await appendLocalLog(grant([foreign]), request(foreign))).result).toBe("failed");
    const link = join(vault, "Link.md");
    await symlink(foreign, link);
    expect((await appendLocalLog(grant([link]), request(link))).result).toBe("failed");
    expect(await readFile(foreign, "utf8")).toBe("not yours\n");
  });

  test("a note in the root that is not the designated write target is denied", async () => {
    const other = join(vault, "Other.md");
    await writeFile(other, "x\n");
    expect((await appendLocalLog(grant([note]), request(other))).result).toBe("failed");
  });

  test("the designated log note is not ingested as evidence (no self-made obligations)", async () => {
    await writeFile(join(vault, "Plan.md"), "Real work\n");
    const { records } = await scanSelected(grant(), markdownReader);
    expect(records.map((r) => r.externalId)).toEqual(["Plan.md"]);
  });
});
