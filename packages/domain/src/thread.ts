// The project chat's generative UI: a small catalog of blocks with flat Zod props. TARS's messages
// are a list of these specs, stored on the message and updated in place as real work happens.
// The server stores only complete blocks (`block`); the renderer reads any spec (`viewBlock`).
import { z } from "zod";
import { SORT_KINDS } from "./sort";

const SourceChip = z.object({ kind: z.string(), count: z.number().int().nonnegative() });
const StepSchema = z.object({
  id: z.string(),
  label: z.string(), // present participle with its object: "Reading 5 items"
  doneLabel: z.string().optional(), // past tense, shown once done: "Read 5 items"
  status: z.enum(["waiting", "running", "done", "failed", "unknown"]), // unknown: nobody could confirm it
  startedAt: z.number().optional(), // real ms timestamps, never estimated
  endedAt: z.number().optional(),
  sources: z.array(SourceChip).optional(),
  error: z.string().optional(), // a few words on what failed
});
export type Step = z.infer<typeof StepSchema>;

/** What each block is for (read by people now, and by a model if one ever composes these). */
export const BLOCKS = {
  work: {
    description: "The working header and its steps: what TARS really did, with real times and the sources it read. Collapses when done.",
    props: z.object({ steps: z.array(StepSchema), retry: z.boolean().optional() }),
  },
  document: {
    description: "The draft TARS made or changed; opens the editable draft. changeSummary/undoRevision after a revision.",
    props: z.object({
      artifactId: z.string(),
      title: z.string(),
      revision: z.string(),
      changeSummary: z.string().optional(),
      undoRevision: z.string().optional(),
    }),
  },
  say: {
    description: "TARS's words (short paragraphs, lists and **bold**: sayParts), with a chip per source it used; a chip with a url opens the item where it lives.",
    props: z.object({ text: z.string(), sources: z.array(z.object({ id: z.string(), label: z.string(), kind: z.string().optional(), url: z.string().optional() })).optional() }),
  },
  approval: {
    description:
      "Exactly what will happen before anything leaves: a Word document of this revision, sent as a link by email, or (form reply) the draft's text itself as an email reply. The recipient is a suggestion from the asking mail's header fields (empty when none), editable by the user. Built from stored data only; it emits an action and never acts.",
    props: z.object({
      projectId: z.string(),
      artifactId: z.string(),
      revision: z.string(),
      commitmentKey: z.string(),
      recipient: z.string(), // the suggested address, "" when there is none
      recipientName: z.string().optional(),
      replySubject: z.string(), // the subject when it goes to the asker (a reply to their mail)
      subject: z.string(), // the subject to anyone else
      document: z.string(), // the draft's title
      form: z.enum(["document", "reply"]).optional(), // how it goes out; absent means "document"
      primary: z.string(),
      secondary: z.string(),
      state: z.enum(["open", "approved"]),
    }),
  },
  allowSend: {
    description: "Asks for the separate permission to send from one connected Composio Gmail source; it emits an action and never sends.",
    props: z.object({ sourceId: z.string(), account: z.string() }),
  },
  delivery: {
    description: "One approved send of the draft; the renderer follows its live status (document, link, send, verify; a reply: send, verify) by action id.",
    props: z.object({ actionId: z.string(), recipient: z.string() }),
  },
  receipt: {
    description: "What was done, when, and what was checked; for a send, the document's name as a link.",
    props: z.object({ text: z.string(), at: z.number(), check: z.string().optional(), document: z.string().optional(), link: z.string().optional() }),
  },
  // Today's blocks: built in the renderer from existing subscriptions (todayThread), never stored.
  results: {
    description: "Outcome lines: a bold past-tense verb, then the count and noun (“Read → 4 new emails”), with the source logo when known.",
    props: z.object({ items: z.array(z.object({ id: z.string(), verb: z.string().optional(), text: z.string(), kind: z.string().optional() })) }),
  },
  start: {
    description: "The brief as a short numbered list, the recommended start first and typed out, with why; Help me start / Improve content first.",
    props: z.object({
      items: z.array(
        z.object({
          text: z.string(),
          projectId: z.string(),
          projectName: z.string().optional(),
          kind: z.enum(["meeting", "deadline", "suggested"]),
          dueAt: z.string().optional(),
          recommended: z.boolean(),
        }),
      ),
      reason: z.string().optional(),
      projectId: z.string().optional(),
    }),
  },
  ask: {
    description: "One question with its choices (a nudge, a tradeoff); the user's choice is the only thing that ends it. It emits onChoose and never acts.",
    props: z.object({
      id: z.string(),
      title: z.string(),
      text: z.string(),
      choices: z.array(z.object({ id: z.string(), label: z.string() })),
      primaryId: z.string().optional(),
      note: z.string().optional(),
    }),
  },
  sorted: {
    description: "A brain dump sorted into projects, with Fix on each line.",
    props: z.object({
      view: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("sorting"), projects: z.number().int().nonnegative() }),
        z.object({
          kind: z.literal("sorted"),
          lines: z.array(z.object({ id: z.string(), text: z.string(), projectId: z.string().nullable(), kind: z.enum(SORT_KINDS), dueAt: z.string().optional() })),
        }),
        z.object({ kind: z.literal("failed"), detail: z.string() }),
      ]),
    }),
  },
} as const;

export type BlockType = keyof typeof BLOCKS;
export type BlockProps<T extends BlockType> = z.infer<(typeof BLOCKS)[T]["props"]>;
export type Block = { [T in BlockType]: { id: string; type: T; props: BlockProps<T> } }[BlockType];
export type BlockView =
  | { [T in BlockType]: { id: string; type: T; props: Partial<BlockProps<T>>; complete: boolean } }[BlockType]
  | { id: string; type: "unknown" };

/** A block about to be stored: complete and valid, or it throws. */
export function block<T extends BlockType>(id: string, type: T, props: BlockProps<T>): Block {
  return { id, type, props: BLOCKS[type].props.parse(props) } as Block;
}

const isBlockType = (type: string): type is BlockType => Object.hasOwn(BLOCKS, type);
const RawBlock = z.object({ id: z.string().optional(), type: z.string(), props: z.unknown().optional() });

/** Any spec, never throwing: unknown types become a placeholder; invalid fields (and array items) are dropped. */
export function viewBlock(raw: unknown, index: number): BlockView {
  const parsed = RawBlock.safeParse(raw);
  const id = parsed.success && parsed.data.id ? parsed.data.id : `b${index}`;
  if (!parsed.success || !isBlockType(parsed.data.type)) return { id, type: "unknown" };
  const { type, props } = parsed.data;
  const schema = BLOCKS[type].props;
  const full = schema.safeParse(props);
  if (full.success) return { id, type, props: full.data, complete: true } as BlockView;
  const given = (typeof props === "object" && props !== null ? props : {}) as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape) as [string, z.ZodType][]) {
    const inner = field instanceof z.ZodOptional ? field.unwrap() : field;
    const value = given[key];
    if (inner instanceof z.ZodArray && Array.isArray(value)) {
      kept[key] = value.flatMap((item) => {
        const one = z.safeParse(inner.element, item);
        return one.success ? [one.data] : [];
      });
    } else if (value !== undefined) {
      const one = field.safeParse(value);
      if (one.success) kept[key] = one.data;
    }
  }
  return { id, type, props: kept, complete: false } as BlockView;
}

const ACTIONABLE = new Set(["start", "ask", "approval"]);

/**
 * The one navy action on screen: the newest open start, ask or approval ("messageId/blockId"), or null.
 * Decided here once for the whole thread; blocks never decide it themselves.
 */
export function primaryBlockId(messages: readonly { id: string; views: readonly BlockView[] }[]): string | null {
  for (const m of [...messages].reverse()) {
    // An approval only while open; an ask only when it names a primary choice (a tradeoff's three are equal).
    const open = m.views.findLast((b) => ACTIONABLE.has(b.type) && !(b.type === "approval" && b.props.state !== "open") && !(b.type === "ask" && !b.props.primaryId));
    if (open) return `${m.id}/${open.id}`;
  }
  return null;
}

/** "38s", "1m", "2m 5s": whole seconds, at least one. */
export function formatDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m === 0 ? `${s}s` : s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export type WorkSummary =
  | { state: "running"; label: string; startedAt?: number }
  | { state: "done" | "failed" | "unknown" | "waiting"; label: string };

/** The one line above the steps. A duration only from real start and end times. */
export function workSummary(steps: readonly Partial<Step>[]): WorkSummary {
  const starts = steps.flatMap((s) => (s.startedAt === undefined ? [] : [s.startedAt]));
  const ends = steps.flatMap((s) => (s.endedAt === undefined ? [] : [s.endedAt]));
  const span = starts.length > 0 && ends.length > 0 ? formatDuration(Math.max(...ends) - Math.min(...starts)) : null;
  if (steps.some((s) => s.status === "running")) return { state: "running", label: "Working", ...(starts.length ? { startedAt: Math.min(...starts) } : {}) };
  if (steps.some((s) => s.status === "failed")) return { state: "failed", label: span ? `Stopped after ${span}` : "Stopped" };
  if (steps.some((s) => s.status === "unknown")) return { state: "unknown", label: span ? `Not confirmed after ${span}` : "Not confirmed" };
  if (steps.some((s) => s.status === "waiting")) return { state: "waiting", label: "Waiting" };
  return { state: "done", label: span ? `Worked for ${span}` : "Worked" };
}

export { isMailAddress } from "./actions";

/** delivery.status as the chat reads it (convex/delivery.ts). */
export type DeliveryStatus = {
  state: "pending" | "running" | "succeeded" | "failed" | "unknown";
  verified: boolean;
  recipient: string;
  subject?: string;
  filename?: string | null;
  link?: string | null;
  sentAt?: number;
  stages: { name: "document" | "link" | "send" | "verify"; state: "pending" | "running" | "done" | "failed" | "unknown"; startedAt?: number; endedAt?: number; detail?: string }[];
};

const STAGE_WORDS: Record<DeliveryStatus["stages"][number]["name"], (to: string) => [now: string, done: string]> = {
  document: () => ["Making the Word document", "Made the Word document"],
  link: () => ["Creating its link", "Created its link"],
  send: (to) => [`Sending to ${to}`, `Sent to ${to}`],
  verify: () => ["Checking it arrived", "Checked: it arrived"],
};
const STAGE_STATUS = { pending: "waiting", running: "running", done: "done", failed: "failed", unknown: "unknown" } as const;

/** The send's real stages as work steps, with their real times and the backend's own words when it fails or is unconfirmed. */
export function deliverySteps(status: DeliveryStatus): Step[] {
  return status.stages.map((stage) => {
    const [label, doneLabel] = STAGE_WORDS[stage.name](status.recipient);
    // A verified send (also one a Check again settled) is done in every step.
    const state = status.verified ? "done" : STAGE_STATUS[stage.state];
    return {
      id: stage.name,
      label,
      doneLabel,
      status: state,
      ...(stage.startedAt === undefined ? {} : { startedAt: stage.startedAt }),
      ...(stage.endedAt === undefined ? {} : { endedAt: stage.endedAt }),
      ...(stage.detail !== undefined && (state === "failed" || state === "unknown") ? { error: stage.detail } : {}),
    };
  });
}

/** "Saturday at 5:00 PM" in the user's zone. */
export const dueLabel = (dueAt: string, timezone: string) => {
  const at = new Date(dueAt);
  const day = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: timezone }).format(at);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone }).format(at);
  return `${day} at ${time}`;
};

/** Bracketed evidence ids a preparation left in text ("[gmail-15ac84d1:18d1]"): never shown on screen. */
export const stripEvidenceIds = (text: string) => text.replace(/\s*\[(?:[a-z]+-)+[0-9a-f]{6,}[^\]\n]*\]/g, "");

/** A block with nothing to show renders nothing; the unknown-type placeholder and incomplete approvals still show. */
export function blockHasContent(view: BlockView): boolean {
  switch (view.type) {
    case "work":
      return (view.props.steps?.length ?? 0) > 0;
    case "say":
      return (view.props.text?.trim() ?? "") !== "" || (view.props.sources?.length ?? 0) > 0;
    case "document":
      return view.props.artifactId !== undefined || view.props.title !== undefined;
    case "delivery":
      return view.props.actionId !== undefined;
    case "allowSend":
      return view.props.sourceId !== undefined;
    case "receipt":
      return (view.props.text?.trim() ?? "") !== "";
    default:
      return true;
  }
}


export type SaySpan = { text: string; bold?: true };
export type SayPart = { kind: "p" | "ul" | "ol"; lines: SaySpan[][] };

const spans = (line: string): SaySpan[] =>
  line
    .split(/\*\*(\S(?:.*?\S)?)\*\*/)
    .flatMap((text, i): SaySpan[] => (text === "" ? [] : [i % 2 === 1 ? { text, bold: true } : { text }]));

/**
 * TARS's words as paragraphs and lists: a blank line ends a paragraph, lines starting "- " or "1."
 * form one list, **bold** marks a run. Anything else the model wrote (a heading mark) is shown as words.
 */
export function sayParts(text: string): SayPart[] {
  const parts: SayPart[] = [];
  let open: { kind: SayPart["kind"]; lines: string[] } | null = null;
  const close = () => {
    if (open === null) return;
    parts.push({ kind: open.kind, lines: open.kind === "p" ? [spans(open.lines.join(" "))] : open.lines.map(spans) });
    open = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^#+\s+/, "");
    if (line === "") {
      close();
      continue;
    }
    const item = /^(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
    const kind = item === null ? "p" : item[1] === undefined ? "ul" : "ol";
    if (open !== null && open.kind !== kind) close();
    open ??= { kind, lines: [] };
    open.lines.push(item === null ? line : item[2]!);
  }
  close();
  return parts;
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * TARS's words as a Telegram message (parse mode HTML): everything escaped, then **bold** and list
 * lines become Telegram's own marks; blank lines stay, so paragraphs keep their spacing. Links are
 * added only from `links` (stored addresses of items a run read), never from the words themselves.
 */
export function phoneHtml(text: string, links: readonly { label: string; url: string }[]): string {
  const body = escapeHtml(text)
    .split("\n")
    .map((line) => line.replace(/^\s*[-*•]\s+/, "• ").replace(/\*\*(\S(?:.*?\S)?)\*\*/g, "<b>$1</b>"))
    .join("\n");
  const list = links.map(({ label, url }) => `• <a href="${escapeHtml(url).replace(/"/g, "&quot;")}">${escapeHtml(label).replace(/"/g, "&quot;")}</a>`);
  return list.length === 0 ? body : `${body}\n\n${list.join("\n")}`;
}
