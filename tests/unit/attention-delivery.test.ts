import { describe, expect, test, vi } from "vitest";
import type { AttentionInput } from "@companion/domain";
import { startAttentionDelivery, type AttentionState } from "../../apps/desktop/src/main/attention";

const input: AttentionInput = {
  kind: "morning",
  now: "2026-11-14T14:00:00.000Z",
  timezone: "America/New_York",
  working: false,
  meeting: false,
  quiet: false,
  availability: "available",
  panelOpen: false,
  alreadyDelivered: false,
  hasPreparedWork: true,
};
const morning: AttentionState = { input, key: "morning:2026-11-14", title: "Today", body: "Tighten the pitch opening." };

function fakes(panelOpen = false) {
  let push: (state: AttentionState) => void = () => {};
  const deps = {
    showNotification: vi.fn(async () => {}),
    isPanelOpen: vi.fn(() => panelOpen),
    subscribe: vi.fn((onState: (state: AttentionState) => void) => {
      push = onState;
      return vi.fn();
    }),
    markDelivered: vi.fn(async () => {}),
  };
  const delivery = startAttentionDelivery(deps);
  return { deps, delivery, push: (state: AttentionState) => push(state) };
}

describe("attention delivery", () => {
  test("notify_shows_exactly_one_notification_and_reports_receipt", async () => {
    const { deps, delivery } = fakes();
    expect(await delivery.handle(morning)).toBe("notified");
    // The subscription fires again before the receipt has round-tripped: still one notification.
    expect(await delivery.handle(morning)).toBe("skipped");
    expect(deps.showNotification).toHaveBeenCalledTimes(1);
    expect(deps.showNotification).toHaveBeenCalledWith({ title: "Today", body: "Tighten the pitch opening." });
    expect(deps.markDelivered).toHaveBeenCalledTimes(1);
    expect(deps.markDelivered).toHaveBeenCalledWith({ key: "morning:2026-11-14", channel: "notification" });
  });

  test("panel_only_never_calls_the_notifier", async () => {
    const { deps, delivery } = fakes(true);
    expect(await delivery.handle(morning)).toBe("skipped");
    expect(await delivery.handle({ ...morning, input: { ...input, kind: "evening" }, key: "evening:2026-11-14" })).toBe("skipped");
    expect(deps.showNotification).not.toHaveBeenCalled();
    expect(deps.markDelivered).not.toHaveBeenCalled();
  });

  test("deferred_and_evening_states_do_not_notify", async () => {
    const { deps, delivery } = fakes();
    expect(await delivery.handle({ ...morning, input: { ...input, working: true } })).toBe("skipped");
    expect(await delivery.handle({ ...morning, input: { ...input, availability: "unknown" } })).toBe("skipped");
    expect(await delivery.handle({ ...morning, input: { ...input, kind: "evening" }, key: "evening:2026-11-14" })).toBe("skipped");
    expect(await delivery.handle(null)).toBe("skipped");
    expect(deps.showNotification).not.toHaveBeenCalled();
    // Released once the user is explicitly available.
    expect(await delivery.handle(morning)).toBe("notified");
    expect(deps.showNotification).toHaveBeenCalledTimes(1);
  });

  test("failed_notification_records_no_receipt", async () => {
    const { deps, delivery } = fakes();
    deps.showNotification.mockRejectedValueOnce(new Error("notifications unavailable"));
    await expect(delivery.handle(morning)).rejects.toThrow("notifications unavailable");
    expect(deps.markDelivered).not.toHaveBeenCalled();
  });

  test("subscription_drives_delivery_and_stop_unsubscribes", async () => {
    const { deps, delivery, push } = fakes();
    push(morning);
    await vi.waitFor(() => expect(deps.markDelivered).toHaveBeenCalledTimes(1));
    const unsubscribe = deps.subscribe.mock.results[0]!.value as ReturnType<typeof vi.fn>;
    delivery.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
