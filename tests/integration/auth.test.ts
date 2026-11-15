// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";

const modules = import.meta.glob("../../convex/**/*.*s");

const alice = { tokenIdentifier: "https://test.auth0/|alice", subject: "alice" };
const bob = { tokenIdentifier: "https://test.auth0/|bob", subject: "bob" };

function setup() {
  return convexTest(schema, modules);
}

describe("owner isolation", () => {
  test("owner_cannot_read_other_owner", async () => {
    const t = setup();
    const asAlice = t.withIdentity(alice);
    const asBob = t.withIdentity(bob);

    await asAlice.mutation(api.projects.createProject, { name: "AI Guides" });
    await asAlice.mutation(api.projects.createProject, { name: "AVT" });

    expect(await asBob.query(api.projects.listProjects, {})).toEqual([]);

    const aliceProjects = await asAlice.query(api.projects.listProjects, {});
    expect(aliceProjects.map((p) => p.name).sort()).toEqual(["AI Guides", "AVT"]);
    for (const project of aliceProjects) {
      expect(Object.keys(project).sort()).toEqual(["id", "name"]);
    }
  });

  test("unauthenticated_is_rejected", async () => {
    const t = setup();
    await expect(t.query(api.projects.listProjects, {})).rejects.toThrow(/not authenticated/i);
    await expect(t.mutation(api.projects.createProject, { name: "AVT" })).rejects.toThrow(
      /not authenticated/i,
    );
  });

  test("client_cannot_choose_owner", async () => {
    const t = setup();
    const asBob = t.withIdentity(bob);
    await t.withIdentity(alice).mutation(api.projects.createProject, { name: "AI Guides" });

    // Neither function declares an ownerId argument, so the validator must reject one.
    await expect(
      asBob.mutation(api.projects.createProject, {
        name: "Hijack",
        ownerId: alice.tokenIdentifier,
      } as never),
    ).rejects.toThrow(/ownerId/);
    await expect(
      asBob.query(api.projects.listProjects, { ownerId: alice.tokenIdentifier } as never),
    ).rejects.toThrow(/ownerId/);

    expect(await asBob.query(api.projects.listProjects, {})).toEqual([]);
  });
});

describe("project name validation", () => {
  test("trims surrounding whitespace", async () => {
    const asAlice = setup().withIdentity(alice);
    await asAlice.mutation(api.projects.createProject, { name: "  AVT  " });
    expect(await asAlice.query(api.projects.listProjects, {})).toMatchObject([{ name: "AVT" }]);
  });

  test.each([
    ["empty", ""],
    ["whitespace only", "   \t "],
    ["longer than 100 characters", "x".repeat(101)],
  ])("rejects a name that is %s", async (_label, name) => {
    const asAlice = setup().withIdentity(alice);
    await expect(asAlice.mutation(api.projects.createProject, { name })).rejects.toThrow(
      /project name/i,
    );
    expect(await asAlice.query(api.projects.listProjects, {})).toEqual([]);
  });

  test("accepts a name of exactly 100 characters", async () => {
    const asAlice = setup().withIdentity(alice);
    await asAlice.mutation(api.projects.createProject, { name: "x".repeat(100) });
    expect(await asAlice.query(api.projects.listProjects, {})).toHaveLength(1);
  });
});
