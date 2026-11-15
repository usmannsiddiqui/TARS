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
