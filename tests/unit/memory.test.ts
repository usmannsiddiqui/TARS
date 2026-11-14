import { describe, expect, test } from "vitest";
import type { EvidenceId, MemoryFact, OwnerId, ProjectId, Suppression } from "@companion/domain";
import { isSuppressed, normalizeKey, suppressionVerdict, visibleFacts } from "../../packages/domain/src/memory";

const owner = "owner-alice" as OwnerId;
const guides = "project-ai-guides" as ProjectId;
const avt = "project-avt" as ProjectId;
const e1 = "evidence-1" as EvidenceId;
const e2 = "evidence-2" as EvidenceId;

const suppression = (overrides: Partial<Suppression> = {}): Suppression => ({
  ownerId: owner,
  projectId: guides,
  key: "slide_style",
  evidenceIds: [e1],
  active: true,
  ...overrides,
});

const fact = (overrides: Partial<MemoryFact>): MemoryFact => ({
  id: "fact",
  ownerId: owner,
  projectId: guides,
  key: "deck_tone",
  value: "plain",
  evidenceIds: [],
  scope: "project",
  revision: 1,
  ...overrides,
});

describe("normalizeKey", () => {
  test("lowercases and joins words with underscores", () => {
    expect(normalizeKey("  Slide Style! ")).toBe("slide_style");
    expect(normalizeKey("slide-style")).toBe("slide_style");
  });
});

describe("suppressionVerdict", () => {
  test("same key is blocked, whatever the evidence", () => {
    expect(suppressionVerdict({ projectId: guides, key: "Slide Style", evidenceIds: [e2] }, [suppression()])).toBe(
      "blocked",
    );
  });

  test("similar key from the same evidence is blocked", () => {
    expect(
      suppressionVerdict({ projectId: guides, key: "slides_visual_style", evidenceIds: [e1] }, [suppression()]),
    ).toBe("blocked");
  });

  test("similar key from new evidence is withheld for review", () => {
    expect(
      suppressionVerdict({ projectId: guides, key: "slides_visual_style", evidenceIds: [e2] }, [suppression()]),
    ).toBe("withheld");
  });

  test("different key from the forgotten evidence is withheld for review", () => {
    expect(suppressionVerdict({ projectId: guides, key: "deck_look", evidenceIds: [e1] }, [suppression()])).toBe(
      "withheld",
    );
  });

  test("unrelated key is allowed", () => {
    expect(suppressionVerdict({ projectId: guides, key: "deck_tone", evidenceIds: [e2] }, [suppression()])).toBe(
      "allowed",
    );
  });

  test("a project suppression does not cover another project, a global one covers all", () => {
    expect(suppressionVerdict({ projectId: avt, key: "slide_style", evidenceIds: [] }, [suppression()])).toBe(
      "allowed",
    );
    const { projectId: _project, ...global } = suppression();
    void _project;
    expect(suppressionVerdict({ projectId: avt, key: "slide_style", evidenceIds: [] }, [global])).toBe("blocked");
  });

  test("a global candidate is covered by any project suppression", () => {
    expect(suppressionVerdict({ key: "slide_style", evidenceIds: [] }, [suppression()])).toBe("blocked");
  });

  test("an inactive suppression (relearning allowed) is ignored", () => {
    expect(
      suppressionVerdict({ projectId: guides, key: "slide_style", evidenceIds: [e1] }, [suppression({ active: false })]),
    ).toBe("allowed");
  });
});

describe("isSuppressed (retrieval filter)", () => {
  test("hides same and similar keys, keeps other facts from the same evidence", () => {
    const suppressions = [suppression()];
    expect(isSuppressed(fact({ key: "slide_style" }), suppressions)).toBe(true);
    expect(isSuppressed(fact({ key: "slides_visual_style" }), suppressions)).toBe(true);
    expect(isSuppressed(fact({ key: "deck_tone", evidenceIds: [e1] }), suppressions)).toBe(false);
  });
});

describe("visibleFacts", () => {
  test("project facts stay in their project; global facts show everywhere", () => {
    const local = fact({ id: "local", projectId: guides });
    const global = fact({ id: "global", scope: "global", key: "writing_voice" });
    const { projectId: _omit, ...withoutProject } = global;
    void _omit;
    const facts = [local, withoutProject];
    expect(visibleFacts(facts, guides, []).map((f) => f.id)).toEqual(["local", "global"]);
    expect(visibleFacts(facts, avt, []).map((f) => f.id)).toEqual(["global"]);
  });

  test("suppressed facts are not visible", () => {
    expect(visibleFacts([fact({ key: "slide_style" })], guides, [suppression()])).toEqual([]);
  });
});
