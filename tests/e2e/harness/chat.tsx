// TEST-ONLY: illustrative project-chat threads for the harness scenes (shapes of thread.listThread).
// Every state the chat can show, plus "play": the real running -> done sequence with real timings.
import { useEffect, useState } from "react";
import type { DeliveryStatus } from "../../../packages/domain/src/thread";
import type { ThreadMessage } from "../../../apps/desktop/src/renderer/Thread";
import type { ChatActions } from "../../../apps/desktop/src/renderer/ProjectView";

const S = 1000;
const title = "Presenter run-through for the co-presentation";
const sources = [
  { kind: "outlook-mail", count: 2 },
  { kind: "obsidian", count: 1 },
];
const read = { id: "read", label: "Reading 3 items", doneLabel: "Read 3 items", sources };
const draft = { id: "draft", label: `Drafting “${title}”`, doneLabel: `Drafted “${title}”` };
const save = { id: "save", label: "Checking it against the sources and saving it", doneLabel: "Checked it against the sources and saved it" };
const asked =
  "Co-presenter asked: “Send the final slide order to the co-presenter.” It's due Friday 2:00 PM. I started the draft while you were busy. Tell me what to change, or send it.";

/** TARS's first message, `at` ms into the run (38 s in all when done). */
function opening(t0: number, at: number): ThreadMessage {
  const steps =
    at < 8_400
      ? [{ ...read, status: "running", startedAt: t0 }, { ...draft, status: "waiting" }, { ...save, status: "waiting" }]
      : at < 31_200
        ? [{ ...read, status: "done", startedAt: t0, endedAt: t0 + 8_400 }, { ...draft, status: "running", startedAt: t0 + 8_400 }, { ...save, status: "waiting" }]
        : [
            { ...read, status: "done", startedAt: t0, endedAt: t0 + 8_400 },
            { ...draft, status: "done", startedAt: t0 + 8_400, endedAt: t0 + 31_200 },
            { ...save, status: "done", startedAt: t0 + 31_200, endedAt: t0 + 38_000 },
          ];
  const done = at >= 38_000;
  return {
    id: "m1",
    role: "tars",
    createdAt: t0,
    blocks: [
      { id: "work", type: "work", props: { steps } },
      ...(done ? [{ id: "document", type: "document", props: { artifactId: "art1", title, revision: "3" } }, { id: "say", type: "say", props: { text: asked } }] : []),
    ],
  };
}

const user = (id: string, at: number, text: string): ThreadMessage => ({ id, role: "user", text, blocks: [], createdAt: at });

const COPRESENTER = "copresenter@example.com";
/** TARS's answer to "send it": the approval, with who asked as the suggestion (from the mail's header fields). */
const askedToSend = (at: number, state: "open" | "approved"): ThreadMessage => ({
  id: "m2",
  role: "tars",
  createdAt: at,
  blocks: [
    { id: "work", type: "work", props: { steps: [{ id: "read", label: "Reading your message", doneLabel: "Read your message", status: "done", startedAt: at, endedAt: at + 1_400 }] } },
    { id: "say", type: "say", props: { text: "Here is exactly what will go out. Nothing leaves until you press Send it." } },
    {
      id: "approval",
      type: "approval",
      props: {
        projectId: "guides",
        artifactId: "art1",
        revision: "3",
        commitmentKey: "guides:send the final slide order to the co-presenter",
        recipient: COPRESENTER,
        recipientName: "Co-presenter",
        replySubject: "Re: Slide order for the 20 November session",
        subject: "Presenter run-through for the co-presentation",
        document: title,
        primary: "Send it",
        secondary: "Not yet",
        state,
      },
    },
  ],
});

/** delivery.status fixtures, on the backend's real wording (convex/delivery.ts). */
export function deliveryFixture(actionId: string, now: number): DeliveryStatus {
  const t = now - 9 * S;
  const base = { recipient: COPRESENTER, subject: "Re: Slide order for the 20 November session", filename: "AI Guides.docx", link: "https://illustrative.convex.site/d/illustrative-token" };
  const done = (name: "document" | "link" | "send" | "verify", from: number, to: number) => ({ name, state: "done" as const, startedAt: t + from, endedAt: t + to });
  if (actionId === "act-sending") {
    return { ...base, state: "running", verified: false, stages: [done("document", 0, 1_300), done("link", 1_300, 1_700), { name: "send", state: "running", startedAt: t + 1_700 }, { name: "verify", state: "pending" }] };
  }
  if (actionId === "act-unknown") {
    return {
      ...base,
      state: "unknown",
      verified: false,
      stages: [done("document", 0, 1_300), done("link", 1_300, 1_700), { name: "send", state: "unknown", startedAt: t + 1_700, endedAt: t + 8_900, detail: "We could not confirm this was sent. Nothing has been repeated. Check again in the app." }, { name: "verify", state: "pending" }],
    };
  }
  return { ...base, state: "succeeded", verified: true, sentAt: t + 4_100, stages: [done("document", 0, 1_300), done("link", 1_300, 1_700), done("send", 1_700, 4_100), done("verify", 4_100, 6_200)] };
}
const readMessage = (at: number, ms: number) => ({ id: "read", label: "Reading your message", doneLabel: "Read your message", status: "done", startedAt: at, endedAt: at + ms });
const reply = (id: string, at: number, blocks: unknown[]): ThreadMessage => ({ id, role: "tars", createdAt: at, blocks });

export function chatThread(variant: string, now: number): ThreadMessage[] {
  const t0 = now - 6 * 60 * S;
  const first = opening(t0, 38_000);
  const later = t0 + 4 * 60 * S;
  switch (variant) {
    case "running":
      return [opening(now - 12_000, 12_000)];
    case "empty":
      return [];
    case "revised":
      return [
        first,
        user("u1", later, "Tighten the intro to one line"),
        reply("m2", later, [
          { id: "work", type: "work", props: { steps: [readMessage(later, 1_900), { id: "revise", label: "Revising the draft", doneLabel: "Revised the draft to revision 4", status: "done", startedAt: later + 1_900, endedAt: later + 6_300 }] } },
          { id: "document", type: "document", props: { artifactId: "art1", title, revision: "4", changeSummary: "Cut the welcome to one line and kept the timings.", undoRevision: "3" } },
          { id: "say", type: "say", props: { text: "The welcome is one line now; the 25 minutes still add up. Undo is on the draft if you want the old one back." } },
        ]),
      ];
    case "answer":
      return [
        first,
        user("u1", later, "When does the co-presenter need it?"),
        reply("m2", later, [
          { id: "work", type: "work", props: { steps: [readMessage(later, 3_200)] } },
          { id: "say", type: "say", props: { text: "By Friday at 2:00 PM, so you can both rehearse that afternoon. Slides 9–18 are still a first pass.", sources: [{ id: "e1", label: "Co-presentation on 20 November" }, { id: "e2", label: "Slides 9–18 already exist" }] } },
        ]),
      ];
    case "approval":
      return [first, user("u1", later, "Looks good, send it"), askedToSend(later, "open")];
    case "permission":
      return [
        first,
        user("u1", later, "Looks good, send it"),
        askedToSend(later, "open"),
        reply("m3", later + 20 * S, [
          { id: "say", type: "say", props: { text: "Sending from Gmail hasn't been allowed yet. Allow it below, then press Send it." } },
          { id: "allow-gmail", type: "allowSend", props: { sourceId: "gmail-illustrative", account: "Gmail" } },
        ]),
      ];
    case "sending":
    case "verified":
    case "unknown":
      return [first, user("u1", later, "Looks good, send it"), askedToSend(later, "approved"), reply("m3", later + 20 * S, [{ id: "delivery", type: "delivery", props: { actionId: `act-${variant}`, recipient: COPRESENTER } }])];
    case "failed":
      return [
        first,
        user("u1", later, "Tighten the intro to one line"),
        reply("m2", later, [{ id: "work", type: "work", props: { retry: true, steps: [{ ...readMessage(later, 60_000), status: "failed", error: "The model request failed (timeout)." }] } }]),
      ];
    case "long": {
      const turns: [string, string][] = [
        ["Make the demo part shorter", "Cut the live demo from 10 to 7 minutes and moved the spare 3 to questions."],
        ["Who runs the room camera?", "Your sources don't say. The venue note mentions a hybrid room but no camera owner."],
        ["Add a line thanking the IT team", "Added one line of thanks before the questions."],
        ["What did the co-presenter say about slides 9–18?", "That they're a first pass and she'll tidy them before you meet."],
        ["Move questions before the exercise", "Questions now come before the choosing-a-tool exercise."],
        ["Is the total still 25 minutes?", "Yes: 2 + 7 + 8 + 8 is 25 minutes."],
      ];
      return [
        first,
        ...turns.flatMap(([ask, said], i) => {
          const at = later + i * 40 * S;
          return [user(`u${i}`, at, ask), reply(`m${i}`, at, [{ id: "work", type: "work", props: { steps: [readMessage(at, 2_100 + i * 300)] } }, { id: "say", type: "say", props: { text: said } }])];
        }),
      ];
    }
    default:
      return [first];
  }
}

/** "play": the first message moves from running to done in place, on the run's real timings (sped up 10x). */
export function useChatThread(variant: string, now: number): [ThreadMessage[], (next: ThreadMessage[]) => void] {
  const [thread, setThread] = useState(() => (variant === "play" ? [opening(now, 0)] : chatThread(variant, now)));
  useEffect(() => {
    if (variant !== "play") return;
    const timers = [8_400, 31_200, 38_000].map((at) => setTimeout(() => setThread([opening(now, at)]), at / 10));
    return () => timers.forEach(clearTimeout);
  }, [variant, now]);
  return [thread, setThread];
}

type Sending = { allowed: "allowed" | "not-allowed" };
/** Illustrative: Gmail sending starts not allowed; pressing Allow flips it (as composio.allowSend does). */
export const useSendingFixture = () => useState<Sending>({ allowed: "not-allowed" });

export function chatActions(
  thread: ThreadMessage[],
  setThread: (next: ThreadMessage[]) => void,
  record: (...args: unknown[]) => void,
  [sending, setSending]: [Sending, (next: Sending) => void],
): ChatActions {
  return {
    send: async (text) => {
      record("sendMessage", text);
      const at = Date.now();
      setThread([...thread, user(`u${at}`, at, text), reply(`m${at}`, at, [{ id: "work", type: "work", props: { steps: [{ id: "read", label: "Reading your message", status: "running", startedAt: at }] } }])]);
    },
    approve: async (args) => {
      record("approve", args);
      const at = Date.now();
      setThread([
        ...thread.map((m) => ({ ...m, blocks: m.blocks.map((b) => ((b as { type: string }).type === "approval" ? { ...(b as object), props: { ...(b as { props: object }).props, state: "approved" } } : b)) })),
        // Illustrative: the harness send goes straight to verified.
        reply(`m${at}`, at, [{ id: "delivery", type: "delivery", props: { actionId: "act-verified", recipient: args.recipient } }]),
      ]);
    },
    retry: async (messageId) => record("retry", messageId),
    useDeliveryStatus: (actionId) => deliveryFixture(actionId, Date.now()),
    checkAgain: async (actionId) => record("reconcileAction", actionId),
    useSendingState: () => sending.allowed,
    allowSend: async (sourceId) => (record("allowSend", sourceId), setSending({ allowed: "allowed" })),
  };
}
