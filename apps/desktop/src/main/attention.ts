// Contact delivery: turns the backend's attention state into at most one OS notification per key.
// The decision is the shared pure policy, evaluated with the live panel state only main knows.
// index.ts passes Electron's Notification, the panel window state, a Convex
// subscription to briefs.getAttentionState and the briefs.markDelivered mutation.
import type { AttentionInput } from "@companion/domain";
import { decideAttention } from "@companion/domain/attention";

/** The shape briefs.getAttentionState returns. */
export type AttentionState = { input: AttentionInput; key: string; title: string; body: string } | null;

export type AttentionDeps = {
  showNotification: (notification: { title: string; body: string }) => void | Promise<void>;
  isPanelOpen: () => boolean;
  subscribe: (onState: (state: AttentionState) => void) => () => void;
  markDelivered: (receipt: { key: string; channel: "notification" }) => Promise<void>;
};

export function startAttentionDelivery(deps: AttentionDeps) {
  // Keys notified in this process: the subscription can fire again before the receipt round-trips.
  const notified = new Set<string>();

  async function handle(state: AttentionState): Promise<"notified" | "skipped"> {
    if (state === null || notified.has(state.key)) return "skipped";
    if (decideAttention({ ...state.input, panelOpen: deps.isPanelOpen() }) !== "notify") return "skipped";
    notified.add(state.key);
    try {
      await deps.showNotification({ title: state.title, body: state.body });
    } catch (error) {
      notified.delete(state.key); // not shown: no receipt, so it stays deliverable
      throw error;
    }
    // shortcut: if this receipt write fails, a later process could notify this key once more.
    await deps.markDelivered({ key: state.key, channel: "notification" });
    return "notified";
  }

  const unsubscribe = deps.subscribe((state) => {
    handle(state).catch((error: unknown) => {
      console.error("attention delivery failed:", error instanceof Error ? error.name : "unknown");
    });
  });
  return { handle, stop: unsubscribe };
}
