// The one model client: OpenAI Responses API with a strict JSON schema. Every failure becomes a
// ModelError with a short code; evidence text, model text and the key are never logged or echoed.
import { z } from "zod";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODEL_TIMEOUT_MS = 60_000;

export class ModelError extends Error {
  constructor(readonly code: string) {
    super(`Model request failed: ${code}`);
  }
}

// Only the envelope fields we read; anything else in the response is ignored.
const Envelope = z.object({
  status: z.string(),
  incomplete_details: z.object({ reason: z.string() }).nullish(),
  output: z.array(
    z.object({
      type: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    }),
  ),
});

/** Ask the model for output matching `schema`. Env is read per request so a missing value fails that request. */
export async function generateStructured<T>(request: {
  name: string;
  schema: z.ZodType<T>;
  instructions: string;
  input: string;
}): Promise<T> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey) throw new ModelError("missing_OPENAI_API_KEY");
  if (!model) throw new ModelError("missing_OPENAI_MODEL");

  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(request.schema);
  void _dialect;
  let response: Response;
  try {
    response = await fetch(RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        instructions: request.instructions,
        input: request.input,
        store: false,
        text: { format: { type: "json_schema", name: request.name, schema: jsonSchema, strict: true } },
      }),
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
  const text = content.find((part) => part.type === "output_text")?.text;
  if (text === undefined) throw new ModelError("parse");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ModelError("parse");
  }
  const parsed = request.schema.safeParse(json);
  if (!parsed.success) throw new ModelError("parse");
  return parsed.data;
}
