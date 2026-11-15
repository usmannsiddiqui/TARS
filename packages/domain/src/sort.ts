// Brain dump sorting: the model files the user's own words into their projects with a kind. Pure: no I/O.
// Model output is untrusted: project ids are checked against the user's own list, kinds against the
// four known ones, due times by the preparation rules. Sorting only labels; it never creates an action.
import { z } from "zod";
import { dueInstant } from "./prepare";

export const SORT_KINDS = ["todo", "waiting", "parked", "idea"] as const;
export type SortKind = (typeof SORT_KINDS)[number];
export const SORT_LIMITS = { maxItems: 20, maxText: 280 };

// Strict JSON schema sent to the model. `kind` is a plain string so one odd kind degrades to "idea"
// instead of failing the whole sort.
export const SortOutputSchema = z.strictObject({
  items: z.array(
    z.strictObject({ text: z.string(), projectId: z.string().nullable(), kind: z.string(), dueAt: z.string().nullable() }),
  ),
});
export type SortOutput = z.infer<typeof SortOutputSchema>;
export type SortedItem = { text: string; projectId: string | null; kind: SortKind; dueAt?: string };

const isKind = (kind: string): kind is SortKind => (SORT_KINDS as readonly string[]).includes(kind);

/** Untrusted model output -> at most 20 bounded items. `zoneKnown` false: relative dates cannot be resolved, so none is kept. */
export function validateSort(output: SortOutput, projectIds: ReadonlySet<string>, nowMs: number, zoneKnown: boolean): SortedItem[] {
  const items: SortedItem[] = [];
  for (const raw of output.items) {
    if (items.length >= SORT_LIMITS.maxItems) break;
    const squashed = raw.text.replace(/\s+/g, " ").trim();
    if (squashed === "") continue;
    const text = squashed.length > SORT_LIMITS.maxText ? `${squashed.slice(0, SORT_LIMITS.maxText - 1)}…` : squashed;
    const dueAt = zoneKnown ? dueInstant(raw.dueAt, [nowMs]) : undefined;
    items.push({
      text,
      projectId: raw.projectId !== null && projectIds.has(raw.projectId) ? raw.projectId : null,
      kind: isKind(raw.kind) ? raw.kind : "idea",
      ...(dueAt === undefined ? {} : { dueAt }),
    });
  }
  return items;
}

export const NO_PROJECT = "No project yet";

/** Items grouped in the user's project order, then "No project yet" (no project, or one that is gone). */
export function groupSorted<T extends { projectId: string | null }>(
  items: readonly T[],
  projects: readonly { id: string; name: string }[],
): { projectId: string | null; name: string; items: T[] }[] {
  const known = new Set(projects.map((p) => p.id));
  const groups = projects.map((p) => ({ projectId: p.id as string | null, name: p.name, items: items.filter((i) => i.projectId === p.id) }));
  groups.push({ projectId: null, name: NO_PROJECT, items: items.filter((i) => i.projectId === null || !known.has(i.projectId)) });
  return groups.filter((g) => g.items.length > 0);
}
