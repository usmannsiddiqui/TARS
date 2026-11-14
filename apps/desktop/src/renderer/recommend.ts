// One recommended start across projects. Pure: no I/O, never changes focus (only the user does).
// Rule from the storyboard: keep the user's previous choice unless a real deadline makes another start more urgent.
import type { ProjectSummary, Recommendation } from "./model";

const URGENT_MS = 48 * 60 * 60 * 1000;
const dueLabel = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

export function recommendStart(projects: ProjectSummary[], focusId: string | undefined, now: string): Recommendation | null {
  const nowMs = Date.parse(now);
  const urgent = projects
    .flatMap((p) => p.commitments.filter((c) => c.ownership === "user" && c.state === "open" && c.dueAt).map((c) => ({ p, c, due: Date.parse(c.dueAt!) })))
    .filter(({ due }) => due >= nowMs && due - nowMs <= URGENT_MS)
    .sort((a, b) => a.due - b.due)[0];
  if (urgent) return { projectId: urgent.p.id, reason: `${urgent.c.text} is due ${dueLabel.format(urgent.due)}.` };

  const isReady = (p: ProjectSummary) => p.prepared?.status === "ready" && p.prepared.work !== undefined;
  const focus = projects.find((p) => p.id === focusId);
  if (focus) {
    return { projectId: focus.id, reason: `You chose ${focus.name} last, and ${isReady(focus) ? "prepared work is ready" : "your place is saved"}.` };
  }
  const prepared = projects.find(isReady);
  if (prepared) return { projectId: prepared.id, reason: "Prepared work is ready from your sources." };

  const open = (p: ProjectSummary) => p.commitments.filter((c) => c.ownership === "user" && c.state === "open").length;
  const busy = projects.find((p) => open(p) > 0);
  if (busy) return { projectId: busy.id, reason: `You have ${open(busy)} open ${open(busy) === 1 ? "item" : "items"} here.` };
  return null;
}
