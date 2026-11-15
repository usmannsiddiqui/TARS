// Optional AI-context sources: user-selected local Claude Code / Codex CLI session files. Main process only.
// Supports only the JSONL shapes observed on this Mac (2026-11-14); anything else is reported unsupported.
//   Claude Code: ~/.claude/projects/<project>/<session>.jsonl, one record per line,
//     {type: "user"|"assistant", message: {role, content: string | [{type: "text"|"thinking"|"tool_use"|"tool_result"|"image", ...}]}, isMeta?, isSidechain?}
//     plus metadata records of other types (ignored).
//   Codex: ~/.codex/sessions/YYYY/MM/DD/*.jsonl, {type, payload}; turns are
//     {type: "response_item", payload: {type: "message", role: "user"|"assistant"|"developer", content: [{type: "input_text"|"output_text", text}]}}.
// Never Claude Desktop app data and never a whole ~/.claude or ~/.codex tree: only the exact selected folders/files.
import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { Evidence, SourceGrant } from "@companion/domain";
import { coverageLabel, scanSelected, watchSelected, type Extracted, type FileReader, type WatchHandle, type WatchOptions } from "./source-watch";

export const SESSION_CHARS = 4_000; // enough recent context to be useful, small enough to send to a model per session
export const TURN_CHARS = 600;
export const MAX_SESSIONS = 10;
const MAX_SESSION_BYTES = 32 * 1024 * 1024; // observed sessions are a few MB; larger is read-skipped and reported

export type AiRoots = { claudeProjects: string; codexSessions: string };
export const defaultAiRoots = (): AiRoots => ({
  claudeProjects: join(homedir(), ".claude", "projects"),
  codexSessions: join(homedir(), ".codex", "sessions"),
});

type AiKind = "claude-code" | "codex";
type Turn = { role: "user" | "assistant"; text: string };
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const textBlocks = (content: unknown[], types: string[]) =>
  content.filter((b): b is Obj => isObj(b) && types.includes(b["type"] as string) && typeof b["text"] === "string").map((b) => b["text"] as string);

function claudeCodeTurns(records: unknown[]): Turn[] | string {
  const turns: Turn[] = [];
  let recognized = 0;
  for (const r of records) {
    if (!isObj(r) || (r["type"] !== "user" && r["type"] !== "assistant")) continue;
    const role = r["type"];
    const m = r["message"];
    if (!isObj(m) || m["role"] !== role || !(typeof m["content"] === "string" || Array.isArray(m["content"]))) {
      return `a ${role} record has an unrecognized message shape`;
    }
    recognized++;
    if (r["isMeta"] === true || r["isSidechain"] === true) continue; // injected context, subagent turns
    const content = m["content"];
    // Only text: thinking, tool_use, tool_result and image blocks are skipped.
    for (const text of typeof content === "string" ? [content] : textBlocks(content as unknown[], ["text"])) turns.push({ role, text });
  }
  return recognized ? turns : "no Claude Code user/assistant records";
}

function codexTurns(records: unknown[]): Turn[] | string {
  const turns: Turn[] = [];
  let recognized = 0;
  for (const r of records) {
    if (!isObj(r) || r["type"] !== "response_item" || !isObj(r["payload"]) || r["payload"]["type"] !== "message") continue;
    const p = r["payload"];
    const role = p["role"];
    if (!Array.isArray(p["content"])) return "a message record has an unrecognized content shape";
    recognized++;
    if (role !== "user" && role !== "assistant") continue; // developer/system instructions
    for (const text of textBlocks(p["content"], ["input_text", "output_text"])) turns.push({ role, text });
  }
  return recognized ? turns : "no Codex message records";
}

/** Most recent turns first until the session budget is spent, then back in chronological order. */
function excerpt(turns: Turn[]): Extracted {
  const kept: string[] = [];
  let used = 0;
  let truncated = false;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (!turn) continue;
    const body = turn.text.trim();
    if (!body) continue;
    const clipped = body.length > TURN_CHARS ? `${body.slice(0, TURN_CHARS)}…` : body;
    const line = `${turn.role}: ${clipped}`;
    if (used + line.length + 1 > SESSION_CHARS) {
      truncated = true;
      break;
    }
    truncated ||= clipped !== body;
    kept.unshift(line);
    used += line.length + 1;
  }
  return { text: kept.join("\n"), truncated };
}

export function transcriptReader(kind: AiKind): FileReader {
  const parse = kind === "claude-code" ? claudeCodeTurns : codexTurns;
  return {
    // Claude Code: top-level sessions only (subagent transcripts live in <session>/subagents/).
    accepts: (id) => id.endsWith(".jsonl") && (kind === "codex" || !id.includes("/")),
    maxBytes: MAX_SESSION_BYTES,
    maxFiles: MAX_SESSIONS,
    extract(content) {
      const records: unknown[] = [];
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          // A session being written may end in a partial line; it is read on the next change event.
        }
      }
      if (records.length === 0) return { unsupported: "not JSON Lines" };
      const turns = parse(records);
      return typeof turns === "string" ? { unsupported: turns } : excerpt(turns);
    },
  };
}

/** Why this grant's selectors cannot be read as AI context, or null when they can. */
async function unsupportedReason(grant: SourceGrant, roots: AiRoots): Promise<string | null> {
  if (grant.kind !== "claude-code" && grant.kind !== "codex") return `${grant.kind} is not an AI-context source`;
  if (grant.selectors.length === 0) return "nothing selected";
  const surface = grant.kind === "claude-code" ? "Claude Code" : "Codex";
  let base: string;
  try {
    base = await realpath(grant.kind === "claude-code" ? roots.claudeProjects : roots.codexSessions);
  } catch {
    return `no local ${surface} sessions folder on this Mac`;
  }
  for (const selector of grant.selectors) {
    if (/Application Support\/Claude(\/|$)/.test(selector)) {
      return "Claude Desktop app data (including Claude Desktop Projects) is not supported; select a Claude Code project session folder";
    }
    let real: string;
    try {
      real = await realpath(selector);
    } catch {
      return "selected path is missing";
    }
    // Strictly inside: selecting the whole sessions root would mean every project's history.
    if (!real.startsWith(base + sep)) return `only a ${surface} session folder or file under ${base} can be selected`;
  }
  return null;
}

export async function readAiContext(
  grant: SourceGrant,
  roots: AiRoots = defaultAiRoots(),
): Promise<{ records: Evidence[]; coverage: string }> {
  const reason = await unsupportedReason(grant, roots);
  if (reason) return { records: [], coverage: `unsupported: ${reason}` };
  const { records, status } = await scanSelected(grant, transcriptReader(grant.kind as AiKind));
  const label = coverageLabel(grant.kind, status);
  const allUnsupported = records.length === 0 && status.issues.some((i) => i.issue === "unsupported");
  return { records, coverage: allUnsupported ? `unsupported: ${label}` : label };
}

/** Live updates for granted transcript paths, through the same native watcher as notes. */
export async function watchAiContext(
  grant: SourceGrant,
  emit: (evidence: Evidence) => void,
  options: WatchOptions = {},
  roots: AiRoots = defaultAiRoots(),
): Promise<WatchHandle> {
  const reason = await unsupportedReason(grant, roots);
  if (reason) throw new Error(`Unsupported AI-context selection: ${reason}`);
  return watchSelected(grant, emit, { ...options, reader: transcriptReader(grant.kind as AiKind) });
}
