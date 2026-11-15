// The one model client: OpenAI Responses API. generateStructured asks for one strict JSON answer;
// respond is one turn of a tool loop (the caller runs the tools and calls again). Every failure becomes a
// ModelError with a short code; evidence text, model text and the key are never logged or echoed.
import { z } from "zod";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODEL_TIMEOUT_MS = 60_000;

export class ModelError extends Error {
  constructor(readonly code: string) {
    super(`Model request failed: ${code}`);
  }
}

// Only the envelope fields we read; output items keep every other field so a tool loop can send them back as given.
const Envelope = z.object({
  status: z.string(),
  incomplete_details: z.object({ reason: z.string() }).nullish(),
  output: z.array(
    z.looseObject({
      type: z.string(),
      content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).optional(),
      call_id: z.string().optional(),
      name: z.string().optional(),
      arguments: z.string().optional(),
    }),
  ),
});

const jsonSchemaOf = (schema: z.ZodType) => {
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema);
  void _dialect;
  return jsonSchema;
};

/** Strict tool schemas reject string length limits; ours are still enforced when the arguments are parsed. */
const withoutLengths = (schema: unknown): unknown =>
  Array.isArray(schema)
    ? schema.map(withoutLengths)
    : typeof schema === "object" && schema !== null
      ? Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "minLength" && key !== "maxLength").map(([key, value]) => [key, withoutLengths(value)]))
      : schema;

/** One request; returns the completed response's output items. Env is read per request so a missing value fails that request. */
async function request(body: Record<string, unknown>) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey) throw new ModelError("missing_OPENAI_API_KEY");
  if (!model) throw new ModelError("missing_OPENAI_MODEL");
  let response: Response;
  try {
    response = await fetch(RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, store: false, ...body }),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new ModelError(timedOut ? "timeout" : "network");
  }
  if (!response.ok) throw new ModelError(`http_${response.status}`);

  const envelope = Envelope.safeParse(await response.json().catch(() => null));
  if (!envelope.success) throw new ModelError("parse");
  const { status, incomplete_details, output } = envelope.data;
  if (status === "incomplete") throw new ModelError(`incomplete_${incomplete_details?.reason ?? "unknown"}`);
  if (status !== "completed") throw new ModelError(`status_${status}`);
  const content = output.filter((item) => item.type === "message").flatMap((item) => item.content ?? []);
  if (content.some((part) => part.type === "refusal")) throw new ModelError("refusal");
  return { output, text: content.find((part) => part.type === "output_text")?.text };
}

/** Ask the model for output matching `schema`. */
export async function generateStructured<T>(args: { name: string; schema: z.ZodType<T>; instructions: string; input: string }): Promise<T> {
  const { text } = await request({
    instructions: args.instructions,
    input: args.input,
    text: { format: { type: "json_schema", name: args.name, schema: jsonSchemaOf(args.schema), strict: true } },
  });
  if (text === undefined) throw new ModelError("parse");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ModelError("parse");
  }
  const parsed = args.schema.safeParse(json);
  if (!parsed.success) throw new ModelError("parse");
  return parsed.data;
}

export type ModelTool = { name: string; description: string; args: z.ZodType };
export type ModelCall = { callId: string; name: string; args: string };

/**
 * One turn of a tool loop. `input` is the whole conversation so far (nothing is stored at the
 * provider): the caller appends `items` as given, then one `toolResult` per call, and asks again.
 * With no tools offered the model can only write.
 */
export async function respond(args: { instructions: string; input: readonly unknown[]; tools: readonly ModelTool[] }): Promise<{ items: unknown[]; calls: ModelCall[]; text: string }> {
  const { output, text } = await request({
    instructions: args.instructions,
    input: args.input,
    ...(args.tools.length === 0
      ? {}
      : { tools: args.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: withoutLengths(jsonSchemaOf(tool.args)), strict: true })) }),
  });
  const calls = output.flatMap((item) =>
    item.type === "function_call" && item.call_id !== undefined && item.name !== undefined ? [{ callId: item.call_id, name: item.name, args: item.arguments ?? "{}" }] : [],
  );
  return { items: output, calls, text: text ?? "" };
}

export const toolResult = (callId: string, result: unknown) => ({ type: "function_call_output", call_id: callId, output: JSON.stringify(result) });
