// Slack: owner-supplied bot token for an internal app in a workspace they control.
// Updates arrive only through the signed Events API; `connect` does one bounded initial read.
import { ConvexError, v } from "convex/values";
import type { SourceGrant } from "../../packages/domain/src/types";
import { internal } from "../_generated/api";
import { action, httpAction } from "../_generated/server";
import { ingestItems, markChecked, markFailed, requireOwnedSource, type ProviderItem } from "../connections";
import { ProviderError, providerJson, sealCredential, verifyHmacSha256Hex } from "../lib/providerAuth";

const API = "https://slack.com/api";
const REPLAY_WINDOW_SECONDS = 300; // Slack's recommended 5 minutes
const INITIAL_READ_LIMIT = 50; // per selected channel, one page
const TS = /^\d+\.\d+$/;
const ACCESS_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "missing_scope",
  "not_in_channel",
  "channel_not_found",
]);

type SlackMessage = { subtype?: string; ts?: string; text?: string; edited?: { ts?: string } };

async function slackCall(method: string, token: string, params: Record<string, string> = {}) {
  const url = new URL(`${API}/${method}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  // Slack reports most failures as HTTP 200 with ok:false.
  const body = (await providerJson(url.toString(), { headers: { authorization: `Bearer ${token}` } })) as {
    ok?: boolean;
    error?: string;
  } & Record<string, unknown>;
  if (body.ok !== true) {
    const code = body.error ?? "error";
    throw new ProviderError(ACCESS_ERRORS.has(code) ? "missing-access" : "needs-retry", `slack_${code}`);
  }
  return body;
}

const tsToIso = (ts: string) => new Date(Math.floor(Number(ts) * 1000)).toISOString();

/** A human message (or thread broadcast) as a provider item; joins, bots and deletions are skipped. */
function toItem(channel: string, message: SlackMessage | undefined): ProviderItem | null {
  if (message === undefined || typeof message.text !== "string" || !TS.test(message.ts ?? "")) return null;
  if (message.subtype !== undefined && message.subtype !== "thread_broadcast") return null;
  const edited = message.edited?.ts;
  const version = edited !== undefined && TS.test(edited) ? edited : message.ts!;
  return { externalId: `${channel}:${message.ts}`, version, text: message.text, occurredAt: tsToIso(version) };
}

/** Bounded read of each selected channel: one page, newer than `cursor` (a Slack ts) when given. */
export async function readSelected(ctx: Parameters<typeof ingestItems>[0], grant: SourceGrant, botToken: string, cursor?: string) {
  const items: ProviderItem[] = [];
  for (const channel of grant.selectors) {
    const page = await slackCall("conversations.history", botToken, {
      channel,
      limit: String(INITIAL_READ_LIMIT),
      ...(cursor === undefined ? {} : { oldest: cursor }),
    });
    for (const message of (page.messages ?? []) as SlackMessage[]) {
      const item = toItem(channel, message);
      if (item !== null) items.push(item);
    }
  }
  const newest = items.map((item) => item.externalId.split(":")[1]!).sort().at(-1) ?? cursor;
  const records = await ingestItems(ctx, grant, items);
  return newest === undefined ? { records } : { records, cursor: newest };
}

export const connect = action({
  args: { sourceId: v.string(), botToken: v.string() },
  returns: v.null(),
  handler: async (ctx, { sourceId, botToken }): Promise<null> => {
    const { ownerId, grant } = await requireOwnedSource(ctx, sourceId, "slack");
    let teamId: string;
    try {
      teamId = String((await slackCall("auth.test", botToken)).team_id);
    } catch (error) {
      if (error instanceof ProviderError) throw new ConvexError(error.message);
      throw error;
    }
    await ctx.runMutation(internal.connections.save, {
      ownerId,
      sourceId,
      provider: "slack",
      accountKey: teamId,
      credential: await sealCredential({ botToken }),
    });
    try {
      const { cursor } = await readSelected(ctx, grant, botToken);
      await markChecked(ctx, sourceId, cursor);
    } catch (error) {
      throw new ConvexError((await markFailed(ctx, sourceId, error)).message);
    }
    return null;
  },
});

const ok = () => new Response(null, { status: 200 });

/** POST /slack/events. Verify over the raw body, then store inline (the event carries the text). */
export const handleEvent = httpAction(async (ctx, request) => {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) throw new Error("SLACK_SIGNING_SECRET is not set");
  const raw = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";
  const fresh = /^\d+$/.test(timestamp) && Math.abs(Date.now() / 1000 - Number(timestamp)) <= REPLAY_WINDOW_SECONDS;
  const valid =
    fresh &&
    signature.startsWith("v0=") &&
    (await verifyHmacSha256Hex(secret, `v0:${timestamp}:${raw}`, signature.slice(3)));
  if (!valid) return new Response("invalid signature", { status: 401 });

  let payload: {
    type?: string;
    challenge?: string;
    team_id?: string;
    event?: SlackMessage & { type?: string; channel?: string; message?: SlackMessage };
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("invalid body", { status: 400 });
  }
  if (payload.type === "url_verification") {
    return new Response(JSON.stringify({ challenge: payload.challenge }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  const event = payload.event;
  if (payload.type !== "event_callback" || typeof payload.team_id !== "string") return ok();
  if (event?.type !== "message" || typeof event.channel !== "string") return ok();

  const found = await ctx.runQuery(internal.connections.byAccount, { provider: "slack", accountKey: payload.team_id });
  if (found?.grant == null || !found.grant.selectors.includes(event.channel)) return ok();
  const item = toItem(event.channel, event.subtype === "message_changed" ? event.message : event);
  if (item !== null) await ingestItems(ctx, found.grant, [item]);
  return ok();
});
