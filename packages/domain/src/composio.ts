// Composio tool policy. Pure: no I/O.
// A tool slug (TOOLKIT_VERB_OBJECT, e.g. GMAIL_SEND_EMAIL) is a read only when its name clearly
// only reads. Everything else, unknown verbs and mixed names included, is a write and may run only
// inside actions.executeIntent. The tool's own metadata is never trusted to downgrade a write.

const SLUG = /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/;
const READS = new Set(["GET", "LIST", "SEARCH", "FETCH", "READ", "FIND", "QUERY", "LOOKUP", "VIEW", "RETRIEVE", "DOWNLOAD", "COUNT"]);
// Words that change something, or join two operations; any one makes the name a write.
const WRITES = new Set([
  "SEND", "POST", "CREATE", "UPDATE", "DELETE", "REMOVE", "ADD", "SET", "MOVE", "ARCHIVE", "UNARCHIVE", "TRASH",
  "UNTRASH", "MARK", "MODIFY", "PATCH", "PUT", "REPLY", "FORWARD", "INVITE", "UPLOAD", "SHARE", "RENAME", "COPY",
  "EDIT", "WRITE", "INSERT", "APPEND", "REPLACE", "CLEAR", "CANCEL", "ACCEPT", "DECLINE", "RESPOND", "SCHEDULE",
  "START", "STOP", "ENABLE", "DISABLE", "JOIN", "LEAVE", "KICK", "PIN", "UNPIN", "REACT", "STAR", "UNSTAR", "LABEL",
  "UNLABEL", "SUBSCRIBE", "UNSUBSCRIBE", "APPROVE", "REJECT", "PUBLISH", "IMPORT", "EXECUTE", "RUN", "TRIGGER",
  "OPEN", "CLOSE", "DRAFT", "SAVE", "SYNC", "RESTORE", "REVOKE", "GRANT", "ASSIGN", "UNASSIGN",
  "AND", "OR", "THEN",
]);

/** `readOnlyHint` is accepted only to state that it is ignored: the name alone decides. */
export function isWriteTool(tool: { slug: string; readOnlyHint?: boolean }): boolean {
  if (!SLUG.test(tool.slug)) return true;
  const words = tool.slug.split("_");
  return !words.some((word) => READS.has(word)) || words.some((word) => WRITES.has(word));
}

// ---- Connect-form selectors. One rule, used by the form and again by the server before any trigger exists.
export type ParsedSelectors = { selectors: string[] } | { error: string };
const items = (text: string) => text.split(",").map((s) => s.trim()).filter((s) => s !== "");

// GitHub's own limits: an owner is letters, digits and hyphens (max 39); a repository adds `.` and `_`.
const REPOSITORY = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
/** Repositories as `owner/name`, lower-cased (GitHub names are case-insensitive) so events match reliably. */
export function parseRepositories(text: string): ParsedSelectors {
  const repos = items(text);
  const bad = repos.find((r) => !REPOSITORY.test(r));
  if (repos.length === 0 || bad !== undefined) {
    return { error: `${bad === undefined ? "Add at least one repository" : `"${bad}" is not a repository`}: write each as owner/name, like octo-labs/website.` };
  }
  return { selectors: repos.map((r) => r.toLowerCase()) };
}

const CHANNEL = /^[CG][A-Z0-9]+$/;
export function parseSlackChannels(text: string): ParsedSelectors {
  const channels = items(text);
  const bad = channels.find((c) => !CHANNEL.test(c));
  if (channels.length === 0 || bad !== undefined) {
    return { error: `${bad === undefined ? "Add at least one channel ID" : `"${bad}" is not a channel ID`}: a channel ID starts with C (or G for an older private channel), then capital letters and digits.` };
  }
  return { selectors: channels };
}

/** Gmail reads the inbox unless the user picks labels; picking labels and naming none is an error, never an empty trigger. */
export function gmailSelectors(choice: "inbox" | "labels", text: string): ParsedSelectors {
  if (choice === "inbox") return { selectors: ["INBOX"] };
  const labels = items(text);
  return labels.length > 0 ? { selectors: labels } : { error: "Add at least one label ID, or read the inbox instead." };
}
