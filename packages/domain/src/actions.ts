// Instructed-action policy: what an instruction is bound to, and the markers that let us find an
// effect again without repeating it. Pure: no I/O. Source and model text never reach this module
// as authority; only the user's instruction (destination + artifact revision + content hash) does.
import type { ActionIntent, Artifact } from "./types";

// One plain address: no whitespace (so no CR/LF header injection), no lists, no display names.
const MAIL_ADDRESS = /^[^\s@<>,;"()[\]\\]+@[^\s@<>,;"()[\]\\]+\.[^\s@<>,;"()[\]\\]+$/;
const MAX_SUBJECT = 120;
// One Slack conversation id (public/private channel or DM), never a name or a list.
const SLACK_CHANNEL = /^[CGD][A-Z0-9]{8,}$/;

/** SHA-256 hex of the exact text the user approved. */
export async function contentHash(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type BindingCheck = { ok: true } | { ok: false; reason: string };
type Binding = Pick<ActionIntent, "kind" | "destination"> & {
  projectId: string;
  artifactId: string;
  revision: string;
  contentHash: string;
};

/** The instruction still names the current text exactly; anything else is a question, not a send. */
export function checkBinding(intent: Binding, current: Artifact, currentHash: string): BindingCheck {
  if (intent.artifactId !== current.id || intent.projectId !== current.projectId) {
    return { ok: false, reason: "That draft is not part of this project." };
  }
  if (intent.revision !== current.revision || intent.contentHash !== currentHash) {
    return { ok: false, reason: "The draft changed after you asked. Check the current version and ask again." };
  }
  if (intent.kind === "send-mail" && !MAIL_ADDRESS.test(intent.destination)) {
    return { ok: false, reason: "Give one email address to send it to." };
  }
  if (intent.kind === "post-message" && !SLACK_CHANNEL.test(intent.destination)) {
    return { ok: false, reason: "Give one Slack channel ID to post it to." };
  }
  if (intent.destination.trim().length === 0) return { ok: false, reason: "Say where it should go." };
  return { ok: true };
}

export const actionMarker = (actionId: string) => `tars-action-${actionId}`;
export const logMarker = (actionId: string) => `tars-log-${actionId}`;
/** Message-ID we set on sent mail, so the provider can find it again (Gmail `rfc822msgid:`). */
export const messageIdFor = (actionId: string) => `<${actionMarker(actionId)}@tars.invalid>`;

export function mailSubject(text: string): string {
  const first = text.split("\n").find((line) => line.trim().length > 0) ?? "";
  return first.trim().slice(0, MAX_SUBJECT);
}

/** One line for the outcome log; the marker makes a repeated append detectable. */
export function outcomeLogEntry(outcome: {
  actionId: string;
  kind: ActionIntent["kind"];
  destination: string;
  externalId?: string;
  verifiedAt?: string;
}): string {
  const what =
    outcome.kind === "send-mail"
      ? `Sent mail to ${outcome.destination}`
      : outcome.kind === "post-message"
        ? `Posted to Slack channel ${outcome.destination}`
        : `Updated note ${outcome.destination}`;
  const id = outcome.externalId === undefined ? "" : ` (provider id ${outcome.externalId})`;
  return `${outcome.verifiedAt ?? ""} ${what}${id}, verified. [${logMarker(outcome.actionId)}]`.trim();
}

/** What one provider effect or lookup established. Only read-back verification is "succeeded". */
export type EffectOutcome = { state: "succeeded" | "failed" | "unknown"; externalId?: string; reason?: string };

/**
 * A provider failure after the request left us. A timeout, dropped connection, 5xx or an accepted
 * (2xx) response we could not read may have been delivered, so it is unknown (never resent); a 4xx
 * was refused, so it failed.
 */
export const outcomeForFailure = (code: string): "unknown" | "failed" =>
  code === "timeout" || code === "network" || code === "unexpected_response" || /^http_5\d\d$/.test(code) ? "unknown" : "failed";

/** Line endings and outer whitespace differ by provider; the approved words must all be there. */
export const sameContent = (stored: string, approved: string) =>
  stored.replace(/\r\n/g, "\n").includes(approved.replace(/\r\n/g, "\n").trim());
