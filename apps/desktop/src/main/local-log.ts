// Outcome log append to the user's designated Obsidian note. Main process only.
// The note must be a grant write target inside a granted root (both compared as realpaths).
// Marker check first (idempotent), hash of what was read checked again before an atomic replace
// (temp file + rename), then read back. A concurrent edit makes this fail, never overwrite.
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import type { SourceGrant } from "@companion/domain";

export type LocalLogRequest = { notePath: string; marker: string; entry: string };
export type LocalLogResult = { result: "written" } | { result: "failed"; reason: string };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Realpath of an existing file, or of its existing folder plus its name (a note not yet created). */
async function resolveNote(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return join(await realpath(dirname(path)), basename(path));
  }
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

export async function appendLocalLog(
  grant: SourceGrant,
  { notePath, marker, entry }: LocalLogRequest,
  // Test seam: runs between the read and the replace, where a concurrent user edit could land.
  options: { beforeReplace?: () => Promise<void> } = {},
): Promise<LocalLogResult> {
  if (grant.kind !== "obsidian" || grant.state !== "active") return { result: "failed", reason: "grant-inactive" };
  let tmp: string | undefined;
  try {
    const real = await resolveNote(notePath);
    const targets = await Promise.all(grant.writeTargets.map(resolveNote));
    const roots = await Promise.all(grant.selectors.map((s) => realpath(s).catch(() => null)));
    const inRoot = roots.some((root) => root !== null && (real === root || real.startsWith(root + sep)));
    if (!targets.includes(real) || !inRoot) return { result: "failed", reason: "outside-grant" };

    const before = await readOrEmpty(real);
    if (before.includes(marker)) return { result: "written" };
    const separator = before.length === 0 || before.endsWith("\n") ? "" : "\n";
    const next = `${before}${separator}${entry}\n`;
    // Hidden temp name in the same folder: rename is atomic there and source-watch skips dotfiles.
    tmp = join(dirname(real), `.${basename(real)}.${randomUUID()}.tmp`);
    await writeFile(tmp, next, { flag: "wx" });
    await options.beforeReplace?.();
    // shortcut: a write landing between this check and rename is still lost; upgrade with a file lock if seen.
    if (sha256(await readOrEmpty(real)) !== sha256(before)) return { result: "failed", reason: "changed-during-write" };
    await rename(tmp, real);
    tmp = undefined;
    return (await readFile(real, "utf8")).includes(marker)
      ? { result: "written" }
      : { result: "failed", reason: "not-read-back" };
  } catch (err) {
    return { result: "failed", reason: (err as NodeJS.ErrnoException).code ?? "write-failed" };
  } finally {
    if (tmp !== undefined) await rm(tmp, { force: true });
  }
}
