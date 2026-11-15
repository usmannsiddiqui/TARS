// @vitest-environment edge-runtime
// Composio: the read/write split for tool slugs, and the webhook signature check.
// Fixture-only: the secret and payloads are illustrative.
import { describe, expect, test } from "vitest";
import { gmailSelectors, isWriteTool, parseRepositories, parseSlackChannels } from "../../packages/domain/src/composio";
import { verifyWebhook } from "../../convex/connectors/composio";

describe("isWriteTool", () => {
  test("names that clearly only read are reads", () => {
    for (const slug of [
      "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      "SLACK_FETCH_CONVERSATION_HISTORY",
      "OUTLOOK_GET_MESSAGE",
      "OUTLOOK_LIST_MESSAGES",
      "GMAIL_SEARCH_PEOPLE",
      "MICROSOFT_TEAMS_GET_CHAT_MESSAGE",
      "SLACK_FIND_USERS",
      "NOTION_READ_PAGE",
    ]) {
      expect(isWriteTool({ slug }), slug).toBe(false);
    }
  });

  test("sends, posts and other changes are writes", () => {
    for (const slug of ["GMAIL_SEND_EMAIL", "SLACK_CHAT_POST_MESSAGE", "OUTLOOK_SEND_EMAIL", "GMAIL_DELETE_DRAFT", "SLACK_OPEN_DM", "GMAIL_MODIFY_THREAD_LABELS"]) {
      expect(isWriteTool({ slug }), slug).toBe(true);
    }
  });

  test("unknown and mixed names fail closed as writes", () => {
    for (const slug of ["GMAIL_FROBNICATE", "SLACK_ARCHIVE_CHANNEL", "GMAIL_FETCH_AND_ARCHIVE", "OUTLOOK_LIST_AND_DELETE_MESSAGES", "GMAIL_GET_OR_CREATE_LABEL", "", "get"]) {
      expect(isWriteTool({ slug }), slug).toBe(true);
    }
  });

  test("a tool's own read-only flag never overrides a write-looking name", () => {
    expect(isWriteTool({ slug: "GMAIL_SEND_EMAIL", readOnlyHint: true })).toBe(true);
    expect(isWriteTool({ slug: "GMAIL_FROBNICATE", readOnlyHint: true })).toBe(true);
    // …and a missing flag does not turn a read into a write.
    expect(isWriteTool({ slug: "OUTLOOK_GET_MESSAGE", readOnlyHint: false })).toBe(false);
  });
});

const SECRET = "illustrative-composio-webhook-secret";
const BODY = JSON.stringify({ id: "msg_illustrative", type: "composio.trigger.message", metadata: {}, data: {} });

async function sign(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  return btoa(String.fromCharCode(...mac));
}

async function headers(overrides: Record<string, string | null> = {}, now = Math.floor(Date.now() / 1000)) {
  const timestamp = String(now);
  const values: Record<string, string | null> = {
    "webhook-id": "msg_illustrative",
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${await sign(SECRET, "msg_illustrative", timestamp, BODY)}`,
    ...overrides,
  };
  const out = new Headers();
  for (const [name, value] of Object.entries(values)) if (value !== null) out.set(name, value);
  return out;
}

describe("verifyWebhook", () => {
  test("a correctly signed, fresh delivery passes", async () => {
    expect(await verifyWebhook(SECRET, await headers(), BODY)).toBe(true);
  });

  test("one valid signature among several passes (rotation)", async () => {
    const good = (await headers()).get("webhook-signature")!;
    expect(await verifyWebhook(SECRET, await headers({ "webhook-signature": `v1,AAAA ${good}` }), BODY)).toBe(true);
  });

  test("a wrong secret, a changed body or a changed id fails", async () => {
    expect(await verifyWebhook("another-secret", await headers(), BODY)).toBe(false);
    expect(await verifyWebhook(SECRET, await headers(), BODY.replace("msg_", "msh_"))).toBe(false);
    expect(await verifyWebhook(SECRET, await headers({ "webhook-id": "msg_other" }), BODY)).toBe(false);
    expect(await verifyWebhook(SECRET, await headers({ "webhook-signature": "v1,not-base64!!" }), BODY)).toBe(false);
  });

  test("missing headers fail", async () => {
    for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
      expect(await verifyWebhook(SECRET, await headers({ [name]: null }), BODY), name).toBe(false);
    }
  });

  test("a replayed delivery outside five minutes fails, even with a valid signature", async () => {
    const old = Math.floor(Date.now() / 1000) - 301;
    expect(await verifyWebhook(SECRET, await headers({}, old), BODY)).toBe(false);
    const future = Math.floor(Date.now() / 1000) + 301;
    expect(await verifyWebhook(SECRET, await headers({}, future), BODY)).toBe(false);
  });
});

describe("connect form selectors", () => {
  test("repositories are owner/name, comma separated, normalised to lower case", () => {
    expect(parseRepositories(" Octo-Labs/App , octo-labs/site.js,octo_x/a")).toEqual({ error: expect.stringMatching(/owner\/name/) });
    expect(parseRepositories(" Octo-Labs/App , octo-labs/site.js")).toEqual({ selectors: ["octo-labs/app", "octo-labs/site.js"] });
    for (const bad of ["", " , ", "octo", "octo/", "/app", "octo/app/extra", "https://github.com/octo/app", "octo/a b"]) {
      expect(parseRepositories(bad), bad).toEqual({ error: expect.stringMatching(/owner\/name/) });
    }
  });

  test("slack channel ids start with C or G and are letters and digits", () => {
    expect(parseSlackChannels("C0123ABC, G01XYZ9")).toEqual({ selectors: ["C0123ABC", "G01XYZ9"] });
    for (const bad of ["", "#general", "general", "D0123ABC", "C", "C01 23", "c0123abc"]) {
      expect(parseSlackChannels(bad), bad).toEqual({ error: expect.stringMatching(/starts with C/) });
    }
  });

  test("gmail reads the inbox by default; only-these-labels needs at least one label", () => {
    expect(gmailSelectors("inbox", "")).toEqual({ selectors: ["INBOX"] });
    expect(gmailSelectors("inbox", "Label_1")).toEqual({ selectors: ["INBOX"] });
    expect(gmailSelectors("labels", "Label_1, Label_2")).toEqual({ selectors: ["Label_1", "Label_2"] });
    expect(gmailSelectors("labels", " , ")).toEqual({ error: expect.stringMatching(/at least one label/) });
  });
});
