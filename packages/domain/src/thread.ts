// The project chat's generative UI: a small catalog of blocks with flat Zod props. TARS's messages
// are a list of these specs, stored on the message and updated in place as real work happens.
// The server stores only complete blocks (`block`); the renderer reads any spec (`viewBlock`).
import { z } from "zod";

const SourceChip = z.object({ kind: z.string(), count: z.number().int().nonnegative() });
const StepSchema = z.object({
  id: z.string(),
  label: z.string(), // present participle with its object: "Reading 5 items"
  doneLabel: z.string().optional(), // past tense, shown once done: "Read 5 items"
  status: z.enum(["waiting", "running", "done", "failed"]),
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
    description: "TARS's two or three sentences, with source chips when it answers from evidence.",
    props: z.object({ text: z.string(), sources: z.array(z.object({ id: z.string(), label: z.string() })).optional() }),
  },
  approval: {
    description: "Exactly what will happen before anything leaves: recipient, subject, attachment. Built from stored data only; it emits an action and never acts.",
    props: z.object({
      projectId: z.string(),
      artifactId: z.string(),
      revision: z.string(),
      commitmentKey: z.string().optional(),
      recipient: z.string(),
      subject: z.string(),
      attachment: z.string(),
      primary: z.string(),
      secondary: z.string(),
      state: z.enum(["open", "approved"]),
    }),
  },
  receipt: {
    description: "What was done, when, and what was checked.",
    props: z.object({ text: z.string(), at: z.number(), check: z.string().optional() }),
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
        const one = inner.element.safeParse(item);
        return one.success ? [one.data] : [];
      });
    } else if (value !== undefined) {
      const one = field.safeParse(value);
      if (one.success) kept[key] = one.data;
    }
  }
  return { id, type, props: kept, complete: false } as BlockView;
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
  | { state: "done" | "failed" | "waiting"; label: string };

/** The one line above the steps. A duration only from real start and end times. */
export function workSummary(steps: readonly Partial<Step>[]): WorkSummary {
  const starts = steps.flatMap((s) => (s.startedAt === undefined ? [] : [s.startedAt]));
  const ends = steps.flatMap((s) => (s.endedAt === undefined ? [] : [s.endedAt]));
  const span = starts.length > 0 && ends.length > 0 ? formatDuration(Math.max(...ends) - Math.min(...starts)) : null;
  if (steps.some((s) => s.status === "running")) return { state: "running", label: "Working", ...(starts.length ? { startedAt: Math.min(...starts) } : {}) };
  if (steps.some((s) => s.status === "failed")) return { state: "failed", label: span ? `Stopped after ${span}` : "Stopped" };
  if (steps.some((s) => s.status === "waiting")) return { state: "waiting", label: "Waiting" };
  return { state: "done", label: span ? `Worked for ${span}` : "Worked" };
}

/** From and Subject of a mail evidence text ("From: …\nSubject: …\n\nbody"), when present. */
export function mailHeaders(text: string): { from?: string; subject?: string } {
  const head = text.split("\n\n")[0] ?? "";
  const field = (name: string) => head.match(new RegExp(`^${name}:[ \\t]*(.+)$`, "mi"))?.[1]?.trim();
  const from = field("From");
  const subject = field("Subject");
  return { ...(from ? { from } : {}), ...(subject ? { subject } : {}) };
}

/** "Saturday 5:00 PM" in the user's zone. */
export const dueLabel = (dueAt: string, timezone: string) =>
  new Intl.DateTimeFormat("en-US", { weekday: "long", hour: "numeric", minute: "2-digit", timeZone: timezone }).format(new Date(dueAt));

/**
 * The user's own message asks to send or approve. Checked on his words, not on the model's choice:
 * evidence can steer a model, it can never type in his chat.
 */
export const asksToSend = (text: string) => /\b(send|sent|approve|approved|ship)\b/i.test(text);
