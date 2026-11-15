// Brain dump sorting: untrusted model output becomes bounded, labelled items, then groups for display.
import { describe, expect, test } from "vitest";
import { SORT_LIMITS, groupSorted, validateSort, type SortOutput } from "../../packages/domain/src/sort";

const NOW = Date.parse("2026-11-15T17:30:00Z");
const projects = new Set(["p-classes", "p-avt", "p-guides"]);
const item = (overrides: Partial<SortOutput["items"][number]> = {}): SortOutput["items"][number] => ({
  text: "Finish the lab report",
  projectId: "p-classes",
  kind: "todo",
  dueAt: null,
  ...overrides,
});

describe("validateSort", () => {
  test("keeps known projects and kinds; unknown project ids become no project, unknown kinds become idea", () => {
    const items = validateSort(
      {
        items: [
          item(),
          item({ text: "Ask Sam for the wiring diagram", projectId: "p-avt", kind: "waiting" }),
          item({ text: "Redo the website", projectId: "p-someone-elses", kind: "parked" }),
          item({ text: "Email everyone the deck", projectId: "p-guides", kind: "send-email" }),
        ],
      },
      projects,
      NOW,
      true,
    );
    expect(items).toEqual([
      { text: "Finish the lab report", projectId: "p-classes", kind: "todo" },
      { text: "Ask Sam for the wiring diagram", projectId: "p-avt", kind: "waiting" },
      { text: "Redo the website", projectId: null, kind: "parked" },
      { text: "Email everyone the deck", projectId: "p-guides", kind: "idea" },
    ]);
  });

  test("due times follow the preparation rules: a UTC instant, bad and absurd dates dropped", () => {
    const due = (dueAt: string | null) => validateSort({ items: [item({ dueAt })] }, projects, NOW, true)[0]!.dueAt;
    expect(due("2026-11-20T23:59:00-05:00")).toBe("2026-11-21T04:59:00.000Z");
    expect(due("Friday")).toBeUndefined();
    expect(due("2026-11-20")).toBeUndefined();
    expect(due("2031-01-01T00:00:00Z")).toBeUndefined(); // more than two years ahead
    expect(due("2026-11-01T00:00:00Z")).toBeUndefined(); // more than a day in the past
    expect(due(null)).toBeUndefined();
  });

  test("no known time zone: no due time is kept, whatever the model said", () => {
    const [only] = validateSort({ items: [item({ dueAt: "2026-11-20T23:59:00Z" })] }, projects, NOW, false);
    expect(only).toEqual({ text: "Finish the lab report", projectId: "p-classes", kind: "todo" });
  });

  test("bounds: at most 20 items, empty lines dropped, each line squashed and cut to the length limit", () => {
    const many = validateSort({ items: Array.from({ length: 30 }, (_, i) => item({ text: `Thought ${i}` })) }, projects, NOW, true);
    expect(many).toHaveLength(SORT_LIMITS.maxItems);
    const [long, ...rest] = validateSort(
      { items: [item({ text: `  ${"word ".repeat(200)}\n` }), item({ text: "   " })] },
      projects,
      NOW,
      true,
    );
    expect(rest).toEqual([]);
    expect(long!.text.length).toBe(SORT_LIMITS.maxText);
    expect(long!.text.endsWith("…")).toBe(true);
    expect(long!.text).not.toMatch(/\s{2}|\n/);
  });
});

describe("groupSorted", () => {
  test("groups by the user's project order, then 'No project yet'; empty groups are left out", () => {
    const groups = groupSorted(
      [
        { id: "i1", text: "Ask Sam", projectId: "p-avt", kind: "waiting" },
        { id: "i2", text: "Lab report", projectId: "p-classes", kind: "todo" },
        { id: "i3", text: "A podcast", projectId: null, kind: "idea" },
        { id: "i4", text: "Battery budget", projectId: "p-avt", kind: "parked" },
        { id: "i5", text: "Gone project", projectId: "p-deleted", kind: "idea" },
      ],
      [
        { id: "p-classes", name: "Classes" },
        { id: "p-guides", name: "AI Guides" },
        { id: "p-avt", name: "Advanced Vehicle Team" },
      ],
    );
    expect(groups.map((g) => [g.name, g.items.map((i) => i.id)])).toEqual([
      ["Classes", ["i2"]],
      ["Advanced Vehicle Team", ["i1", "i4"]],
      ["No project yet", ["i3", "i5"]],
    ]);
    expect(groups.at(-1)!.projectId).toBeNull();
  });
});
