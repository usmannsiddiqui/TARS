// Notion: owner-supplied internal integration token. Updates arrive through signed webhooks
// that carry IDs only, so each event triggers one bounded read of the changed page.
// Deliveries are routed by the `?source=<sourceId>` the owner puts in the subscription URL.
import { ConvexError, v } from "convex/values";
import type { SourceGrant } from "../../packages/domain/src/types";
import { internal } from "../_generated/api";
import { action, httpAction } from "../_generated/server";
import { ingestItems, markChecked, markFailed, requireOwnedSource, type ProviderItem } from "../connections";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { openCredential, ProviderError, providerJson, sealCredential, verifyHmacSha256Hex } from "../lib/providerAuth";

const API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const BLOCK_PAGE_SIZE = 100; // first page of top-level blocks only

type RichText = { plain_text?: string }[];
type NotionPage = {
  id: string;
  last_edited_time: string;
  url?: string;
  in_trash?: boolean;
  properties?: Record<string, { type?: string; title?: RichText }>;
};
type NotionBlock = { type?: string } & Record<string, unknown>;

const normalize = (id: string) => id.replace(/-/g, "").toLowerCase();
const plain = (text: RichText | undefined) => (text ?? []).map((part) => part.plain_text ?? "").join("");

function notionGet(path: string, token: string): Promise<unknown> {
  return providerJson(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}`, "notion-version": NOTION_VERSION },
  });
}

/** Selected and not a write target: the outcome log is never ingested (no log-ingestion loop). */
function readable(grant: SourceGrant, pageId: string): boolean {
  const id = normalize(pageId);
  return grant.selectors.some((s) => normalize(s) === id) && !grant.writeTargets.some((w) => normalize(w) === id);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchPage(token: string, pageId: string): Promise<ProviderItem | null> {
  const id = normalize(pageId);
  const page = (await notionGet(`/pages/${id}`, token)) as NotionPage;
  if (page.in_trash === true) return null;
  const children = (await notionGet(`/blocks/${id}/children?page_size=${BLOCK_PAGE_SIZE}`, token)) as {
    results?: NotionBlock[];
  };
  const title = Object.values(page.properties ?? {}).find((p) => p.type === "title")?.title;
  const lines = (children.results ?? []).map((block) => {
    const content = block.type === undefined ? undefined : (block[block.type] as { rich_text?: RichText } | undefined);
    return plain(content?.rich_text);
  });
  const text = [plain(title), ...lines].filter((line) => line.length > 0).join("\n");
  // last_edited_time is minute-granular; the content hash separates edits within one minute.
  return {
    externalId: id,
    version: `${page.last_edited_time}#${await sha256Hex(text)}`,
    text,
    occurredAt: new Date(page.last_edited_time).toISOString(),
    ...(page.url === undefined ? {} : { sourceUrl: page.url }),
  };
}

/** Bounded read of each readable selected page. */
export async function readSelected(ctx: Parameters<typeof ingestItems>[0], grant: SourceGrant, token: string) {
  const items: ProviderItem[] = [];
  for (const pageId of grant.selectors.filter((id) => readable(grant, id))) {
    const item = await fetchPage(token, pageId);
    if (item !== null) items.push(item);
  }
  return { records: await ingestItems(ctx, grant, items) };
}

export const connect = action({
  args: { sourceId: v.string(), token: v.string() },
  returns: v.null(),
  handler: async (ctx, { sourceId, token }): Promise<null> => {
    const { ownerId, grant } = await requireOwnedSource(ctx, sourceId, "notion");
    try {
      await notionGet("/users/me", token);
    } catch (error) {
      if (error instanceof ProviderError) throw new ConvexError(error.message);
      throw error;
    }
    await ctx.runMutation(internal.connections.save, {
      ownerId,
      sourceId,
      provider: "notion",
      accountKey: sourceId, // deliveries carry ?source=, so the source is the routing key
      credential: await sealCredential({ token }),
    });
    try {
      await readSelected(ctx, grant, token);
      await markChecked(ctx, sourceId);
    } catch (error) {
      throw new ConvexError((await markFailed(ctx, sourceId, error)).message);
    }
    return null;
  },
});

/** The handshake token, shown only to the owner so they can paste it into Notion's Verify dialog. */
export const revealVerificationToken = action({
  args: { sourceId: v.string() },
  returns: v.string(),
  handler: async (ctx, { sourceId }): Promise<string> => {
    const { connection } = await requireOwnedSource(ctx, sourceId, "notion");
    if (connection?.webhookSecret === undefined) throw new ConvexError("No verification token received yet");
    return decryptSecret(connection.webhookSecret);
  },
});

const status = (code: number) => new Response(null, { status: code });

/** POST /notion/events?source=<sourceId> */
export const handleEvent = httpAction(async (ctx, request) => {
  const sourceId = new URL(request.url).searchParams.get("source");
  const raw = await request.text();
  if (sourceId === null) return status(404);
  const { grant, connection } = await ctx.runQuery(internal.connections.context, { sourceId });
  if (grant === null || connection === null || connection.provider !== "notion") return status(404);

  if (connection.webhookSecret === undefined) {
    // One-time handshake: Notion sends the subscription's verification_token unsigned.
    let token: unknown;
    try {
      token = (JSON.parse(raw) as { verification_token?: unknown }).verification_token;
    } catch {
      return status(400);
    }
    if (typeof token !== "string" || !token.startsWith("secret_")) return status(401);
    await ctx.runMutation(internal.connections.setWebhookSecret, { sourceId, webhookSecret: await encryptSecret(token) });
    return status(200);
  }

  const signature = request.headers.get("x-notion-signature") ?? "";
  const secret = await decryptSecret(connection.webhookSecret);
  if (!signature.startsWith("sha256=") || !(await verifyHmacSha256Hex(secret, raw, signature.slice(7)))) {
    return status(401);
  }

  let event: { type?: string; entity?: { id?: string; type?: string } };
  try {
    event = JSON.parse(raw);
  } catch {
    return status(400);
  }
  const pageId = event.entity?.id;
  const relevant =
    event.entity?.type === "page" && event.type?.startsWith("page.") === true && event.type !== "page.deleted";
  if (!relevant || typeof pageId !== "string" || !readable(grant, pageId)) return status(200);

  try {
    const { token } = await openCredential(connection.credential);
    const item = await fetchPage(token!, pageId);
    if (item !== null) await ingestItems(ctx, grant, [item]);
    await markChecked(ctx, sourceId);
    return status(200);
  } catch (error) {
    const failure = await markFailed(ctx, sourceId, error);
    // 503 asks Notion to redeliver later (its own backoff); missing access will not fix itself.
    return status(failure.availability === "needs-retry" ? 503 : 200);
  }
});
