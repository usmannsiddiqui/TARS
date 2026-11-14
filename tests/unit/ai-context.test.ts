// Synthetic transcripts that mirror the observed local shapes (structure only, invented text).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectIdSchema, SourceIdSchema, type SourceGrant, type SourceKind } from "@companion/domain";
import { MAX_SESSIONS, readAiContext, SESSION_CHARS, type AiRoots } from "../../apps/desktop/src/main/ai-context";
import { makeOwners } from "../fixtures";

let dir: string;
let roots: AiRoots;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "companion-ai-")));
  roots = { claudeProjects: join(dir, ".claude", "projects"), codexSessions: join(dir, ".codex", "sessions") };
  mkdirSync(roots.claudeProjects, { recursive: true });
  mkdirSync(roots.codexSessions, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function grant(kind: SourceKind, selectors: string[]): SourceGrant {
  return {
    id: SourceIdSchema.parse("source-ai"),
    ownerId: makeOwners().alice.ownerId,
    kind,
    selectors,
    projectIds: [ProjectIdSchema.parse("project-avt")],
    read: true,
    writeTargets: [],
    cloudProcessing: false,
    version: 1,
    state: "active",
  };
}

const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** Claude Code shape: {type, message: {role, content: string | blocks}}, plus metadata record types. */
function claudeSession(turns: [role: "user" | "assistant", text: string][]): string {
  return jsonl([
    { type: "custom-title", customTitle: "t", sessionId: "s" },
    ...turns.map(([role, text]) =>
      role === "user"
        ? { type: "user", isSidechain: false, message: { role, content: text } }
        : {
            type: "assistant",
            isSidechain: false,
            message: {
              role,
              content: [
                { type: "thinking", thinking: "PRIVATE-THINKING" },
                { type: "text", text },
                { type: "tool_use", id: "t1", name: "Bash", input: { command: "TOOL-PAYLOAD" } },
              ],
            },
          },
    ),
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "TOOL-OUTPUT" }] } },
    { type: "user", isMeta: true, message: { role: "user", content: "META-INJECTED" } },
  ]);
}

function projectDir(name: string): string {
  const p = join(roots.claudeProjects, name);
  mkdirSync(p, { recursive: true });
  return p;
}

describe("readAiContext", () => {
  it("extracts user/assistant text turns from Claude Code sessions and skips tool payloads", async () => {
    const project = projectDir("-Users-demo-AVT");
    writeFileSync(join(project, "s1.jsonl"), claudeSession([["user", "draft the AVT pitch"], ["assistant", "outline ready"]]));
    mkdirSync(join(project, "s1", "subagents"), { recursive: true });
    writeFileSync(join(project, "s1", "subagents", "agent-x.jsonl"), claudeSession([["user", "SUBAGENT"]]));

    const { records, coverage } = await readAiContext(grant("claude-code", [project]), roots);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ externalId: "s1.jsonl", origin: "live", grantVersion: 1 });
    expect(records[0]?.text).toBe("user: draft the AVT pitch\nassistant: outline ready");
    for (const hidden of ["PRIVATE-THINKING", "TOOL-PAYLOAD", "TOOL-OUTPUT", "META-INJECTED", "SUBAGENT"]) {
      expect(records[0]?.text).not.toContain(hidden);
    }
    expect(coverage).toMatch(/^Claude Code CLI sessions/);
    expect(coverage).toContain("1 session read");
  });

  it("claude_code_is_not_claude_desktop_projects", async () => {
    const desktop = join(dir, "Library", "Application Support", "Claude", "projects", "p");
    mkdirSync(desktop, { recursive: true });
    writeFileSync(join(desktop, "s.jsonl"), claudeSession([["user", "x"]]));

    const result = await readAiContext(grant("claude-code", [desktop]), roots);
    expect(result.records).toEqual([]);
    expect(result.coverage).toMatch(/^unsupported: .*Claude Desktop/);

    // A supported Claude Code read never claims Desktop/Projects coverage.
    const project = projectDir("-Users-demo-AVT");
    writeFileSync(join(project, "s1.jsonl"), claudeSession([["user", "x"]]));
    const ok = await readAiContext(grant("claude-code", [project]), roots);
    expect(ok.coverage).not.toMatch(/desktop/i);

    // All of ~/.claude/projects is not a project selection.
    expect((await readAiContext(grant("claude-code", [roots.claudeProjects]), roots)).coverage).toMatch(/^unsupported:/);
    // Non-AI kinds are not handled here.
    expect((await readAiContext(grant("obsidian", [project]), roots)).coverage).toMatch(/^unsupported:/);
  });

  it("unsupported_transcript_is_visible_not_empty_success", async () => {
    const project = projectDir("-Users-demo-AVT");
    writeFileSync(join(project, "changed.jsonl"), jsonl([{ kind: "turn", speaker: "user", body: "new format" }]));
    const result = await readAiContext(grant("claude-code", [project]), roots);
    expect(result.records).toEqual([]);
    expect(result.coverage).toMatch(/^unsupported: /);
    expect(result.coverage).toContain("1 unrecognized format");

    // A known record type whose message shape changed is also unsupported, not silently skipped.
    writeFileSync(join(project, "changed.jsonl"), jsonl([{ type: "user", message: { role: "user", parts: ["x"] } }]));
    expect((await readAiContext(grant("claude-code", [project]), roots)).coverage).toMatch(/^unsupported: /);

    // Mixed: good sessions are read, the bad one is still counted.
    writeFileSync(join(project, "good.jsonl"), claudeSession([["user", "ok"]]));
    const mixed = await readAiContext(grant("claude-code", [project]), roots);
    expect(mixed.records.map((r) => r.externalId)).toEqual(["good.jsonl"]);
    expect(mixed.coverage).toContain("1 unrecognized format");
  });

  it("bounds excerpts per session and sessions per grant, and labels the truncation", async () => {
    const project = projectDir("-Users-demo-AVT");
    const long = Array.from({ length: 40 }, (_, i) => ["user", `turn ${i} ${"y".repeat(400)}`] as ["user", string]);
    writeFileSync(join(project, "long.jsonl"), claudeSession([...long, ["user", "latest question"]]));
    for (let i = 0; i < MAX_SESSIONS + 2; i++) {
      const f = join(project, `s${i}.jsonl`);
      writeFileSync(f, claudeSession([["user", `session ${i}`]]));
      utimesSync(f, new Date(2020, 0, 1 + i), new Date(2020, 0, 1 + i)); // older than long.jsonl
    }

    const { records, coverage } = await readAiContext(grant("claude-code", [project]), roots);
    expect(records).toHaveLength(MAX_SESSIONS);
    const longRecord = records.find((r) => r.externalId === "long.jsonl");
    expect(longRecord?.text.length).toBeLessThanOrEqual(SESSION_CHARS);
    expect(longRecord?.text.endsWith("user: latest question")).toBe(true); // most recent turns kept
    expect(coverage).toContain("1 truncated to recent turns");
    expect(coverage).toContain("3 not read (over the 10-file cap)");
  });

  it("denies a selector or symlink outside the grant", async () => {
    const project = projectDir("-Users-demo-AVT");
    const other = projectDir("-Users-demo-Other");
    writeFileSync(join(other, "private.jsonl"), claudeSession([["user", "OTHER-PROJECT"]]));
    symlinkSync(join(other, "private.jsonl"), join(project, "link.jsonl"));
    writeFileSync(join(project, "mine.jsonl"), claudeSession([["user", "mine"]]));

    const { records, coverage } = await readAiContext(grant("claude-code", [project]), roots);
    expect(records.map((r) => r.externalId)).toEqual(["mine.jsonl"]);
    expect(records.some((r) => r.text.includes("OTHER-PROJECT"))).toBe(false);
    expect(coverage).toContain("1 outside the grant, denied");

    // Path traversal out of the sessions root is rejected before anything is read.
    const outside = join(dir, "elsewhere");
    mkdirSync(outside);
    const traversal = await readAiContext(grant("claude-code", [join(roots.claudeProjects, "..", "..", "elsewhere")]), roots);
    expect(traversal).toEqual({ records: [], coverage: expect.stringMatching(/^unsupported:/) });
  });

  it("reads Codex sessions: user/assistant message text only", async () => {
    const day = join(roots.codexSessions, "2026", "11", "14");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, "rollout-1.jsonl"),
      jsonl([
        { timestamp: "t", type: "session_meta", payload: { id: "x", cwd: "/tmp" } },
        { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "DEV" }] } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the AVT build" }] } },
        { type: "response_item", payload: { type: "reasoning", summary: [], encrypted_content: "ENC" } },
        { type: "response_item", payload: { type: "function_call", name: "shell", arguments: "TOOL" } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "fixed" }] } },
        { type: "event_msg", payload: { type: "token_count" } },
      ]),
    );
    const { records, coverage } = await readAiContext(grant("codex", [roots.codexSessions]), roots);
    expect(coverage).toMatch(/^unsupported:/); // the whole sessions root is not a selection

    const ok = await readAiContext(grant("codex", [day]), roots);
    expect(records).toEqual([]);
    expect(ok.records.map((r) => r.text)).toEqual(["user: fix the AVT build\nassistant: fixed"]);
    expect(ok.coverage).toMatch(/^Codex CLI sessions/);
  });
});
