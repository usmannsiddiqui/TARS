import { describe, expect, it } from "vitest";
import { asksToSend, block, deliverySteps, dueLabel, formatDuration, isMailAddress, primaryBlockId, viewBlock, workSummary } from "../../packages/domain/src/thread";

describe("deliverySteps (the send, in the product's nouns)", () => {
  const status = (over: Partial<Parameters<typeof deliverySteps>[0]> = {}) => ({
    state: "running" as const,
    verified: false,
    recipient: "dana@example.com",
    stages: [
      { name: "document" as const, state: "done" as const, startedAt: 0, endedAt: 900 },
      { name: "link" as const, state: "done" as const, startedAt: 900, endedAt: 1_000 },
      { name: "send" as const, state: "running" as const, startedAt: 1_000 },
      { name: "verify" as const, state: "pending" as const },
    ],
    ...over,
  });

  it("maps the four real stages in order with their real times", () => {
    expect(deliverySteps(status()).map((s) => [s.id, s.status, s.status === "done" ? s.doneLabel : s.label])).toEqual([
      ["document", "done", "Made the Word document"],
      ["link", "done", "Created its link"],
      ["send", "running", "Sending to dana@example.com"],
      ["verify", "waiting", "Checking it arrived"],
    ]);
    expect(deliverySteps(status())[0]).toMatchObject({ startedAt: 0, endedAt: 900 });
  });

  it("failed and unknown carry the backend's own words", () => {
    const failed = deliverySteps(status({ state: "failed", stages: [{ name: "document", state: "failed", startedAt: 0, endedAt: 5, detail: "Not sent. Your draft is kept." }] }));
    expect(failed[0]).toMatchObject({ status: "failed", error: "Not sent. Your draft is kept." });
    const unknown = deliverySteps(status({ state: "unknown", stages: [{ name: "send", state: "unknown", startedAt: 0, endedAt: 5, detail: "We could not confirm this was sent." }] }));
    expect(unknown[0]).toMatchObject({ status: "unknown", error: "We could not confirm this was sent." });
    expect(workSummary(unknown)).toEqual({ state: "unknown", label: "Not confirmed after 1s" });
  });

  it("a verified send is done in every step, even after a check again settled it", () => {
    const settled = deliverySteps(status({ state: "succeeded", verified: true, stages: [{ name: "send", state: "unknown", startedAt: 0, endedAt: 5 }] }));
    expect(settled.map((s) => s.status)).toEqual(["done"]);
    expect(settled[0]!.error).toBeUndefined();
  });

  it("an address is one plain mailbox", () => {
    expect([isMailAddress("dana@example.com"), isMailAddress("Dana <dana@example.com>"), isMailAddress("a@b"), isMailAddress("a@b.co, c@d.co"), isMailAddress("")]).toEqual([true, false, false, false, false]);
  });
});

describe("block catalog", () => {
  it("stores only complete, valid blocks", () => {
    expect(block("s1", "say", { text: "Tell me what to change, or send it." })).toEqual({ id: "s1", type: "say", props: { text: "Tell me what to change, or send it." } });
    expect(() => block("w1", "work", { steps: [{ id: "read", label: "Reading", status: "sideways" as never }] })).toThrow();
  });
});

describe("viewBlock (renderer tolerance)", () => {
  it("unknown type renders as a quiet placeholder, never an error", () => {
    expect(viewBlock({ id: "x", type: "chart", props: { bars: [1, 2] } }, 0)).toEqual({ id: "x", type: "unknown" });
    expect(viewBlock(null, 3)).toEqual({ id: "b3", type: "unknown" });
    expect(viewBlock({ type: 42 }, 1)).toEqual({ id: "b1", type: "unknown" });
  });

  it("missing props keep the fields that are valid and mark the block incomplete", () => {
    const view = viewBlock({ id: "d", type: "document", props: { title: "Budget for Dana", revision: 3 } }, 0);
    expect(view).toEqual({ id: "d", type: "document", props: { title: "Budget for Dana" }, complete: false });
    expect(viewBlock({ id: "a", type: "approval" }, 0)).toEqual({ id: "a", type: "approval", props: {}, complete: false });
  });

  it("a bad step is dropped, the good ones stay", () => {
    const view = viewBlock(
      {
        id: "w",
        type: "work",
        props: { steps: [{ id: "read", label: "Reading 3 items", status: "done", startedAt: 0, endedAt: 900 }, { id: "bad", status: "flying" }] },
      },
      0,
    );
    expect(view).toMatchObject({ type: "work", complete: false, props: { steps: [{ id: "read" }] } });
  });

  it("a complete spec maps straight through", () => {
    const raw = { id: "s", type: "say", props: { text: "Done.", sources: [{ id: "e1", label: "Budget request" }] } };
    expect(viewBlock(raw, 0)).toEqual({ ...raw, complete: true });
  });
});

describe("workSummary (the working header)", () => {
  const done = (id: string, startedAt: number, endedAt: number) => ({ id, label: id, status: "done" as const, startedAt, endedAt });

  it("collapses to past tense with the real duration", () => {
    expect(workSummary([done("read", 1_000, 9_000), done("draft", 9_000, 33_000), done("save", 33_000, 39_000)])).toEqual({ state: "done", label: "Worked for 38s" });
    expect(workSummary([done("read", 0, 72_000)])).toEqual({ state: "done", label: "Worked for 1m 12s" });
  });

  it("running keeps the earliest real start for its clock", () => {
    expect(workSummary([done("read", 5_000, 6_000), { id: "draft", label: "Drafting", status: "running", startedAt: 6_000 }])).toEqual({ state: "running", label: "Working", startedAt: 5_000 });
  });

  it("failed and waiting say so; missing times never invent a duration", () => {
    expect(workSummary([done("read", 0, 12_000), { id: "draft", label: "Drafting", status: "failed", startedAt: 12_000, endedAt: 14_000 }])).toEqual({ state: "failed", label: "Stopped after 14s" });
    expect(workSummary([{ id: "send", label: "Waiting for the send to be wired", status: "waiting" }])).toEqual({ state: "waiting", label: "Waiting" });
    expect(workSummary([{ id: "read", label: "Read", status: "done" }])).toEqual({ state: "done", label: "Worked" });
  });

  it("formats durations in whole seconds and minutes", () => {
    expect([formatDuration(300), formatDuration(38_400), formatDuration(60_000), formatDuration(125_000)]).toEqual(["1s", "38s", "1m", "2m 5s"]);
  });
});

describe("helpers from stored data", () => {
  it("says the due time in the user's own zone", () => {
    expect(dueLabel("2026-11-14T22:00:00.000Z", "America/New_York")).toBe("Saturday 5:00 PM");
  });

  it("only the user's own words can ask to send", () => {
    expect(asksToSend("looks good, send it")).toBe(true);
    expect(asksToSend("Approve it")).toBe(true);
    expect(asksToSend("tighten the intro")).toBe(false);
    expect(asksToSend("when is this due?")).toBe(false);
  });
});

describe("Today's blocks: results, start, ask, sorted", () => {
  it("keeps complete specs whole", () => {
    expect(viewBlock({ id: "r", type: "results", props: { items: [{ id: "1", verb: "Read", text: "4 new emails", kind: "outlook-mail" }] } }, 0)).toMatchObject({ type: "results", complete: true });
    expect(
      viewBlock({ id: "s", type: "start", props: { items: [{ text: "Time the demo", projectId: "p1", kind: "suggested", recommended: true }], reason: "Nothing is due sooner.", projectId: "p1" } }, 0),
    ).toMatchObject({ type: "start", complete: true });
    expect(
      viewBlock({ id: "a", type: "ask", props: { id: "nudge:n1", title: "Slide order", text: "Due Friday.", choices: [{ id: "finish", label: "Finish it" }, { id: "not-now", label: "Not now" }], primaryId: "finish" } }, 0),
    ).toMatchObject({ type: "ask", complete: true });
    expect(viewBlock({ id: "d", type: "sorted", props: { view: { kind: "sorting", projects: 3 } } }, 0)).toMatchObject({ type: "sorted", complete: true });
  });

  it("tolerates bad parts: drops invalid list items and fields, never throws", () => {
    const results = viewBlock({ type: "results", props: { items: [{ id: "1", text: "4 new emails" }, { text: 7 }] } }, 2);
    expect(results).toEqual({ id: "b2", type: "results", props: { items: [{ id: "1", text: "4 new emails" }] }, complete: false });
    const ask = viewBlock({ type: "ask", props: { id: "t1", title: "Competes", choices: [{ id: "keep", label: "Keep both" }, { id: 3 }] } }, 0);
    expect(ask).toMatchObject({ type: "ask", complete: false, props: { id: "t1", title: "Competes", choices: [{ id: "keep", label: "Keep both" }] } });
    const sorted = viewBlock({ type: "sorted", props: { view: { kind: "exploded" } } }, 0);
    expect(sorted).toEqual({ id: "b0", type: "sorted", props: {}, complete: false });
    const start = viewBlock({ type: "start", props: { items: [{ text: "Time the demo", projectId: "p1", kind: "nap", recommended: true }] } }, 0);
    expect(start).toMatchObject({ type: "start", props: { items: [] }, complete: false });
  });

  it("stores only complete blocks", () => {
    expect(() => block("a", "ask", { id: "x", title: "t", text: "t", choices: [] })).not.toThrow();
    expect(() => block("a", "ask", { id: "x", title: "t" } as never)).toThrow();
  });
});

describe("primaryBlockId (the one navy action on screen)", () => {
  const msg = (id: string, blocks: unknown[]) => ({ id, views: blocks.map(viewBlock) });
  const approval = (state: "open" | "approved") => ({ id: "approval", type: "approval", props: { state } });

  it("is the newest open start, ask or approval; older ones are secondary", () => {
    const thread = [
      msg("m1", [{ id: "start", type: "start", props: { items: [] } }]),
      msg("m2", [{ id: "say", type: "say", props: { text: "hi" } }, { id: "ask", type: "ask", props: { id: "n1", title: "t", text: "t", choices: [], primaryId: "finish" } }]),
      msg("m3", [{ id: "say", type: "say", props: { text: "done" } }]),
    ];
    expect(primaryBlockId(thread)).toBe("m2/ask");
  });

  it("an ask with equal choices (a tradeoff) holds no primary, so the older start keeps it", () => {
    const thread = [msg("m1", [{ id: "start", type: "start", props: { items: [] } }]), msg("m2", [{ id: "ask", type: "ask", props: { id: "t1", title: "t", text: "t", choices: [] } }])];
    expect(primaryBlockId(thread)).toBe("m1/start");
  });

  it("skips an approval already approved, and is null when nothing is open", () => {
    expect(primaryBlockId([msg("m1", [approval("open")]), msg("m2", [approval("approved")])])).toBe("m1/approval");
    expect(primaryBlockId([msg("m1", [approval("approved")]), msg("m2", [{ type: "say", props: { text: "x" } }])])).toBeNull();
    expect(primaryBlockId([])).toBeNull();
  });

  it("never picks a work, document, receipt or sorted block", () => {
    expect(primaryBlockId([msg("m1", [{ type: "work", props: { steps: [] } }, { type: "sorted", props: { view: { kind: "sorting", projects: 1 } } }])])).toBeNull();
  });
});
