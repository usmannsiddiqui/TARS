// The one thread (Today and each project). TARS's messages are generative UI: each one is a list of block
// specs from the catalog (packages/domain/src/thread.ts), rendered from any spec and updated in place as
// the subscription moves it (stable keys, so changes animate instead of popping). Blocks emit named
// actions with ids; none of them sends, shares or acts by itself. Which block holds the one navy action
// is decided here once (primaryBlockId), never by a block. Presentational: data and actions arrive as props.
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  blockHasContent,
  deliverySteps,
  sayParts,
  stripEvidenceIds,
  type SaySpan,
  formatDuration,
  isMailAddress,
  primaryBlockId,
  viewBlock,
  workSummary,
  type BlockProps,
  type BlockView,
  type DeliveryStatus,
  type Step,
} from "@companion/domain/thread";
import { SortedDump, type BrainDumpProps } from "./BrainDump";
import { SourceChip, SourceLogo } from "./logos";
import { rowTime, type ThreadMessage } from "./model";
import { AllowSending, formatWhen, reason, scrollWithin, SOURCE_NAME, StateNote, StateTag } from "./ui";

export type ApproveArgs = { projectId: string; artifactId: string; revision: string; commitmentKey: string; recipient: string };
/** Each screen passes the actions its blocks can emit; a block whose action is absent offers nothing to press. */
export type ThreadActions = {
  /** The approval's primary action: send this revision to the recipient as he left the field (thread.send). */
  onApprove?(args: ApproveArgs): Promise<void>;
  onKeepEditing?(): void;
  onOpenDraft?(): void;
  onUndo?(artifactId: string, expectedCurrent: string, undoRevision: string): Promise<void>;
  onRetry?(messageId: string): Promise<void>;
  /** A hook: the live delivery.status of one send (undefined while loading). */
  useDeliveryStatus?(actionId: string): DeliveryStatus | undefined;
  /** "Check again" for an unconfirmed send: looks it up, never resends. */
  onCheckAgain?(actionId: string): Promise<void>;
  /** Today: the recommended start's Help me start / Improve content first. */
  onStart?(projectId: string, mode: "help" | "improve"): void;
  onOpenProject?(projectId: string): void;
  /** Today: the user's choice on an ask (a nudge, a tradeoff, a failed run). */
  onChoose?(askId: string, choiceId: string): Promise<void>;
  /** Today: the sorted brain dump's Fix and Sort again. */
  dump?: BrainDumpProps;
  /** A hook: whether sending from this source is allowed (undefined while loading). */
  useSendingState?(sourceId: string): "allowed" | "not-allowed" | undefined;
  /** The user's consent to send from this source (composio.allowSend); it never sends. */
  onAllowSend?(sourceId: string): Promise<void>;
};

const noStatus = () => undefined;
const GAP_MS = 15 * 60_000;
const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

/** A time line above a message on a new day or after a 15-minute gap, only from stored times. */
function separators(messages: ThreadMessage[], now: number): Map<string, string> {
  const out = new Map<string, string>();
  let last: number | undefined;
  for (const m of messages) {
    if (m.createdAt === undefined) continue;
    const day = rowTime(m.createdAt, now);
    if (last === undefined || m.createdAt - last >= GAP_MS || rowTime(last, now) !== day) out.set(m.id, day === clock.format(m.createdAt) ? day : `${day} ${clock.format(m.createdAt)}`);
    last = m.createdAt;
  }
  return out;
}

export function Thread({ messages, actions, label = "Conversation with TARS" }: { messages: ThreadMessage[]; actions: ThreadActions; label?: string }) {
  const end = useRef<HTMLLIElement>(null);
  const last = messages.at(-1);
  // Opened from a notification or a card: at the latest message. New messages bring it into view.
  useEffect(() => {
    scrollWithin(end.current, ".chat-scroll", "end");
  }, [messages.length, last?.blocks.length]);
  const views = messages.map((m) => ({ ...m, views: m.blocks.map(viewBlock) }));
  // What was already there when the thread opened just renders; only what arrives later opens its space.
  const [shown] = useState(() => new Set(views.flatMap((m) => [m.id, ...m.views.map((b) => `${m.id}/${b.id}`)])));
  const primary = primaryBlockId(views);
  const times = separators(messages, Date.now());
  return (
    <ol className="thread" aria-label={label} aria-live="polite" aria-relevant="additions text">
      {views.map((m) => (
        <li
          key={m.id}
          id={`msg-${m.id}`}
          className="msg"
          data-role={m.role}
          data-new={shown.has(m.id) ? undefined : ""}
          ref={m === views.at(-1) ? end : undefined}
          onAnimationEnd={(e) => {
            if (e.currentTarget === end.current && e.animationName === "helper-open") scrollWithin(e.currentTarget, ".chat-scroll", "end");
          }}
        >
          {times.has(m.id) && (
            <p className="msg-time num" aria-hidden="true">
              {times.get(m.id)}
            </p>
          )}
          {m.role === "user" ? (
            <p className="msg-user inner bubble">
              <span className="sr-only">You: </span>
              {m.text}
            </p>
          ) : (
            <div className="msg-tars">
              <span className="sr-only">TARS: </span>
              {m.views.map((b) => (
                <BlockSlot key={b.id} block={b} messageId={m.id} actions={actions} primary={primary === `${m.id}/${b.id}`} arrived={!shown.has(`${m.id}/${b.id}`)} />
              ))}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

function BlockSlot({ block, messageId, actions, primary, arrived }: { block: BlockView; messageId: string; actions: ThreadActions; primary: boolean; arrived: boolean }) {
  if (!blockHasContent(block)) return null; // nothing to show: no empty card
  return (
    <div className="block-slot" data-type={block.type} data-new={arrived ? "" : undefined}>
      {block.type === "work" ? (
        <WorkBlock props={block.props} {...(actions.onRetry ? { onRetry: () => actions.onRetry!(messageId) } : {})} />
      ) : block.type === "document" ? (
        <DocumentBlock props={block.props} actions={actions} />
      ) : block.type === "say" ? (
        <SayBlock props={block.props} />
      ) : block.type === "approval" ? (
        <ApprovalBlock props={block.props} complete={block.complete} actions={actions} primary={primary} />
      ) : block.type === "receipt" ? (
        <ReceiptBlock props={block.props} />
      ) : block.type === "allowSend" && block.props.sourceId ? (
        <AllowSendBlock sourceId={block.props.sourceId} account={block.props.account ?? "Gmail"} actions={actions} />
      ) : block.type === "delivery" && block.props.actionId ? (
        <DeliveryBlock actionId={block.props.actionId} actions={actions} />
      ) : block.type === "results" ? (
        <ResultsBlock props={block.props} />
      ) : block.type === "start" ? (
        <StartBlock props={block.props} actions={actions} primary={primary} />
      ) : block.type === "ask" ? (
        <AskBlock props={block.props} actions={actions} primary={primary} />
      ) : block.type === "sorted" && block.props.view && actions.dump ? (
        <SortedDump {...actions.dump} view={block.props.view} />
      ) : (
        <p className="quiet small">This part of the message can't be shown here.</p>
      )}
    </div>
  );
}

/** ⌘↵ presses the one primary action, never from a text box with words in it (⌘↵ there sends the message). */
function useCommandEnter(enabled: boolean, press: () => void) {
  const ref = useRef(press);
  ref.current = press;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
      const el = document.activeElement;
      if (el instanceof HTMLTextAreaElement && el.value.trim() !== "") return;
      e.preventDefault();
      ref.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

const CHECK = (
  <svg className="result-check" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M2.5 7.5 5.6 10.4 11.5 3.6" fill="none" stroke="currentColor" strokeWidth="2" />
  </svg>
);

/** Outcome lines: ✓ **Read** → 4 new emails, with the source's logo. */
function ResultsBlock({ props }: { props: Partial<BlockProps<"results">> }) {
  return (
    <ul className="results">
      {(props.items ?? []).map((item) => (
        <li key={item.id} className="result">
          {item.verb ? CHECK : <span className="result-dot" aria-hidden="true" />}
          {item.verb && (
            <>
              <strong className="result-verb">{item.verb}</strong>
              <span className="result-arrow" aria-hidden="true">
                →
              </span>
            </>
          )}
          <span className="result-text">{item.text}</span>
          {item.kind && item.kind !== "commitments" && (
            <span className="result-logo">
              <SourceLogo kind={item.kind} size={16} />
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

// Sentences typed once per app session: coming back to Today shows them whole.
const typedOnce = new Set<string>();

/**
 * TARS's sentence typed out (38 ms a character after 600 ms) behind an accent-coloured block cursor. The
 * whole sentence is one text node from the first frame, so it is read whole; CSS highlights only paint
 * the untyped rest transparent. Reduced motion, or a sentence already typed, shows it at once.
 */
function Typed({ text, className }: { text: string; className: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const node = ref.current?.firstChild;
    if (!node || typedOnce.has(text) || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rest = new Highlight();
    const cursor = new Highlight();
    CSS.highlights.set("type-rest", rest);
    CSS.highlights.set("type-cursor", cursor);
    const span = (from: number, to: number) => {
      const r = new Range();
      r.setStart(node, from);
      r.setEnd(node, to);
      return r;
    };
    const t0 = performance.now();
    let raf = 0;
    const frame = (t: number) => {
      const elapsed = t - t0;
      const typed = Math.max(0, Math.floor((elapsed - 600) / 38));
      rest.clear();
      cursor.clear();
      if (typed >= text.length) {
        typedOnce.add(text);
        CSS.highlights.delete("type-rest");
        CSS.highlights.delete("type-cursor");
        return;
      }
      const lit = elapsed >= 600 || Math.floor(elapsed / 500) % 2 === 0; // blinks while waiting, steady while typing
      if (lit) cursor.add(span(typed, typed + 1));
      rest.add(span(lit ? typed + 1 : typed, text.length));
      raf = requestAnimationFrame(frame);
    };
    frame(t0);
    return () => {
      cancelAnimationFrame(raf);
      CSS.highlights.delete("type-rest");
      CSS.highlights.delete("type-cursor");
    };
  }, [text]);
  return (
    <p ref={ref} className={className}>
      {text}
    </p>
  );
}

/** The brief as a short numbered list: the recommended start first and typed out, with why and the two ways in. */
function StartBlock({ props, actions, primary }: { props: Partial<BlockProps<"start">>; actions: ThreadActions; primary: boolean }) {
  const { projectId } = props;
  const start = projectId && actions.onStart ? (mode: "help" | "improve") => actions.onStart!(projectId, mode) : undefined;
  useCommandEnter(primary && start !== undefined, () => start?.("help"));
  const tail = (item: BlockProps<"start">["items"][number]) =>
    [...(item.kind === "suggested" ? [] : [`${item.kind === "meeting" ? "meeting" : "due"} ${formatWhen(item.dueAt ?? "")}`]), item.projectName ?? "a project"].join(" · ");
  return (
    <ol className="brief-list" aria-label="Today's brief">
      {(props.items ?? []).map((item) => (
        <li key={`${item.projectId}:${item.text}`} data-recommended={item.recommended || undefined}>
          {item.recommended && <span className="brief-start-tag">Recommended start</span>}
          {item.recommended ? <Typed className="brief-step" text={item.text} /> : <p className="brief-text">{item.text}</p>}
          <p className="brief-tail">
            {tail(item)}
            {!item.recommended && item.projectName && actions.onOpenProject && (
              <>
                {" · "}
                <button type="button" className="text-button inline" aria-label={`Open the ${item.projectName} chat`} onClick={() => actions.onOpenProject!(item.projectId)}>
                  Open chat
                </button>
              </>
            )}
          </p>
          {item.recommended && props.reason && (
            <p className="brief-reason">
              <span className="why">Why this one:</span> {props.reason}
            </p>
          )}
          {item.recommended && start && (
            <div className="actions">
              <button type="button" className={primary ? "primary" : "secondary"} onClick={() => start("help")} {...(primary ? { "aria-keyshortcuts": "Meta+Enter" } : {})}>
                Help me start
              </button>
              <button type="button" className="secondary" onClick={() => start("improve")}>
                Improve content first
              </button>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

/** One question with its choices; only the user's choice ends it. */
function AskBlock({ props, actions, primary }: { props: Partial<BlockProps<"ask">>; actions: ThreadActions; primary: boolean }) {
  const headId = useId();
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const choose = async (choiceId: string) => {
    if (!props.id || !actions.onChoose) return;
    setState({ busy: true });
    try {
      await actions.onChoose(props.id, choiceId);
      setState({ busy: false });
    } catch (err) {
      setState({ busy: false, error: reason(err) });
    }
  };
  return (
    <section className="ask block tars-voice" aria-labelledby={headId}>
      <h3 id={headId} className="block-title">
        {props.title ?? "A question for you"}
      </h3>
      {props.text && <p>{props.text}</p>}
      <div className="actions">
        {(props.choices ?? []).map((c) => (
          <button key={c.id} type="button" className={primary && c.id === props.primaryId ? "primary" : "secondary"} disabled={state.busy || !actions.onChoose} onClick={() => void choose(c.id)}>
            {c.label}
          </button>
        ))}
      </div>
      {props.note && <p className="quiet small">{props.note}</p>}
      {state.error && <StateNote state={{ kind: "needs-retry", detail: state.error }} />}
    </section>
  );
}

const MARK: Record<Step["status"], string> = { done: "done", running: "now", waiting: "next", failed: "failed", unknown: "next" };

/** A running clock in CSS from the step's real start (no JS timer): the tape counter, started in the past. */
function Clock({ since }: { since: number }) {
  return <span className="tape-run" style={{ animationDelay: `${-(Date.now() - since)}ms` } as CSSProperties} aria-hidden="true" />;
}

function WorkBlock({ props, onRetry, retryLabel = "Try again" }: { props: Partial<BlockProps<"work">>; onRetry?: () => Promise<void>; retryLabel?: string }) {
  const id = useId();
  const steps = props.steps ?? [];
  const summary = workSummary(steps);
  // Open while it works; it folds itself once it is done, and opens again on a click.
  const [open, setOpen] = useState(summary.state !== "done");
  const was = useRef(summary.state);
  useEffect(() => {
    if (was.current !== summary.state) setOpen(summary.state !== "done");
    was.current = summary.state;
  }, [summary.state]);
  const [busy, setBusy] = useState<string | null>(null);
  const mark = summary.state === "running" ? "now" : summary.state === "done" ? "done" : summary.state === "failed" ? "failed" : "next";  return (
    <section className="work" data-state={summary.state} aria-label={summary.label}>
      <button type="button" className="work-head" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span className="helper-step" data-step={mark} aria-hidden="true" />
        <span key={summary.label} className="work-label">
          {summary.label}
        </span>
        {summary.state === "running" && summary.startedAt !== undefined && (
          <span className="work-clock num">
            <Clock since={summary.startedAt} />
          </span>
        )}
        <svg className="work-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      </button>
      <div className="work-fold" id={id} data-open={open || undefined}>
        <ol className="work-steps" aria-label="Steps">
          {steps.map((step) => (
            <li key={step.id} className="work-step" data-status={step.status}>
              <span className="helper-step" data-step={MARK[step.status]} aria-hidden="true" />
              <span className="work-step-body">
                <span key={step.status} className="work-step-label">
                  {step.status === "done" ? (step.doneLabel ?? step.label) : step.label}
                  {step.status === "failed" && <StateTag state={{ kind: "needs-retry" }} label="Failed" />}
                  {step.status === "waiting" && <StateTag state={{ kind: "scheduled" }} label="Waiting" />}
                  {step.status === "unknown" && <StateTag state={{ kind: "unknown" }} />}
                </span>
                {step.error && <span className="work-step-error">{step.error}</span>}
                {step.sources && step.sources.length > 0 && (
                  <span className="work-step-sources">
                    {step.sources.map((s) => (
                      <SourceChip key={s.kind} kind={s.kind} label={`${SOURCE_NAME[s.kind] ?? s.kind} ${s.count}`} />
                    ))}
                  </span>
                )}
              </span>
              {step.startedAt !== undefined && step.endedAt !== undefined && <span className="work-step-time num">{formatDuration(step.endedAt - step.startedAt)}</span>}
            </li>
          ))}
        </ol>
      </div>
      {props.retry && onRetry && (
        <div className="actions">
          <button
            type="button"
            className="secondary"
            disabled={busy !== null}
            onClick={async () => {
              setBusy("retry");
              try {
                await onRetry();
                setBusy(null);
              } catch (err) {
                setBusy(reason(err));
              }
            }}
          >
            {busy === "retry" ? `${retryLabel}…` : retryLabel}
          </button>
          {busy && busy !== "retry" && <StateNote state={{ kind: "needs-retry", detail: busy }} />}
        </div>
      )}
    </section>
  );
}

function DocumentBlock({ props, actions }: { props: Partial<BlockProps<"document">>; actions: ThreadActions }) {
  const [state, setState] = useState<{ busy: boolean; error?: string; undone?: boolean }>({ busy: false });
  const { artifactId, revision, undoRevision } = props;
  return (
    <article className="doc-card block" aria-label={`Draft: ${props.title ?? "untitled"}`}>
      <span className="doc-icon" aria-hidden="true">
        <svg width="18" height="22" viewBox="0 0 18 22">
          <path d="M1.5 1.5h10l5 5v14h-15z" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M11.5 1.5v5h5M4.5 11h9M4.5 14.5h9M4.5 18h6" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </span>
      <div className="doc-name">
        <h3 className="doc-title">{props.title ?? <span className="quiet">Untitled draft</span>}</h3>
        <p className="quiet small">{revision ? `Revision ${revision}` : "Revision not known"}</p>
        {props.changeSummary && (
          <p className="doc-change">
            <span className="why">Changed:</span> {props.changeSummary}
          </p>
        )}
      </div>
      <div className="doc-actions">
        {actions.onOpenDraft && (
          <button type="button" className="secondary" onClick={actions.onOpenDraft}>
            Open draft
          </button>
        )}
        {artifactId && revision && undoRevision && !state.undone && actions.onUndo && (
          <button
            type="button"
            className="text-button"
            disabled={state.busy}
            onClick={async () => {
              setState({ busy: true });
              try {
                await actions.onUndo!(artifactId, revision, undoRevision);
                setState({ busy: false, undone: true });
              } catch (err) {
                setState({ busy: false, error: reason(err) });
              }
            }}
          >
            Undo
          </button>
        )}
      </div>
      {state.undone && <p className="quiet small doc-undone">Undone: back to revision {undoRevision}.</p>}
      {state.error && <StateNote state={{ kind: "needs-retry", detail: state.error }} />}
    </article>
  );
}

function SayBlock({ props }: { props: Partial<BlockProps<"say">> }) {
  const line = (spans: SaySpan[]) => spans.map((span, i) => (span.bold ? <strong key={i}>{span.text}</strong> : span.text));
  return (
    <div className="say">
      {props.text ? (
        <div className="say-text">
          {sayParts(stripEvidenceIds(props.text)).map((part, i) =>
            part.kind === "p" ? (
              <p key={i}>{line(part.lines[0]!)}</p>
            ) : part.kind === "ul" ? (
              <ul key={i}>{part.lines.map((spans, j) => <li key={j}>{line(spans)}</li>)}</ul>
            ) : (
              <ol key={i}>{part.lines.map((spans, j) => <li key={j}>{line(spans)}</li>)}</ol>
            ),
          )}
        </div>
      ) : (
        <p className="say-text">
          <span className="quiet">…</span>
        </p>
      )}
      {props.sources && props.sources.length > 0 && (
        <p className="say-sources" aria-label="From your sources">
          {props.sources.map((s) =>
            s.url ? (
              <a key={s.id} className="say-source-link" href={s.url} target="_blank" rel="noreferrer noopener" aria-label={`Open ${s.label}`}>
                <SourceChip kind={s.kind ?? "link"} label={s.label} />
              </a>
            ) : (
              <SourceChip key={s.id} kind={s.kind ?? "link"} label={s.label} />
            ),
          )}
        </p>
      )}
    </div>
  );
}

function ApprovalBlock({ props, complete, actions, primary }: { props: Partial<BlockProps<"approval">>; complete: boolean; actions: ThreadActions; primary: boolean }) {
  const headId = useId();
  const fieldId = useId();
  const noteId = useId();
  const [recipient, setRecipient] = useState(props.recipient ?? "");
  const [touched, setTouched] = useState(false);
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const approved = props.state === "approved";
  const { projectId, artifactId, revision, commitmentKey } = props;
  const address = recipient.trim();
  const valid = isMailAddress(address);
  // The suggestion is who asked; sending to them replies to their mail, anyone else gets a fresh subject.
  const toAsker = props.recipient !== undefined && props.recipient !== "" && address.toLowerCase() === props.recipient.toLowerCase();
  const subject = toAsker ? props.replySubject : props.subject;
  const ready = complete && !approved && valid && projectId !== undefined && artifactId !== undefined && revision !== undefined && commitmentKey !== undefined;
  const approve = async () => {
    setTouched(true);
    if (!ready || state.busy || !actions.onApprove) return;
    setState({ busy: true });
    try {
      await actions.onApprove({ projectId, artifactId, revision, commitmentKey, recipient: address });
      setState({ busy: false });
    } catch (err) {
      setState({ busy: false, error: reason(err) });
    }
  };
  // ⌘↵ approves only the open approval that holds the primary action.
  useCommandEnter(primary && !approved, () => void approve());
  const problem = touched && !valid ? (address === "" ? "Add the address to send it to." : "Use one plain email address, like name@example.com.") : null;
  return (
    <section className="approval block tars-voice" aria-labelledby={headId} data-state={props.state}>
      <h3 id={headId} className="block-title">
        {approved ? "Approved" : "Before it goes out"}
      </h3>
      <p className="approval-what">
        {props.form === "reply"
          ? `A reply by email, revision ${revision ?? "not known"}.`
          : `A Word document of ${props.document ? `“${props.document}”` : "the draft"}, revision ${revision ?? "not known"}, sent as a link by email.`}
      </p>
      <dl className="approval-facts">
        <div className="approval-row">
          <dt>{approved ? "To" : <label htmlFor={fieldId}>To</label>}</dt>
          <dd>
            {approved ? (
              address
            ) : (
              <>
                <input
                  id={fieldId}
                  className="approval-to"
                  type="email"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  value={recipient}
                  placeholder="name@example.com"
                  aria-invalid={problem !== null || undefined}
                  aria-describedby={noteId}
                  onChange={(e) => setRecipient(e.target.value)}
                  onBlur={() => setTouched(true)}
                />
                <span id={noteId} className="approval-note quiet small">
                  {problem ?? (toAsker && props.recipientName ? `${props.recipientName}, who asked` : props.recipient ? "Changed from who asked" : "Nobody on record asked; add who gets it")}
                </span>
              </>
            )}
          </dd>
        </div>
        <div className="approval-row">
          <dt>Subject</dt>
          <dd>{subject ?? <span className="quiet">No subject</span>}</dd>
        </div>
      </dl>
      {approved ? (
        <StateNote state={{ kind: "done", detail: "You approved this revision." }} />
      ) : (
        <div className="actions">
          <button type="button" className={primary ? "primary" : "secondary"} disabled={!complete || state.busy} onClick={() => void approve()} {...(primary ? { "aria-keyshortcuts": "Meta+Enter" } : {})}>
            {state.busy ? "Sending…" : (props.primary ?? "Send it")}
            {primary && (
              <kbd className="approval-key" aria-hidden="true">
                ⌘↵
              </kbd>
            )}
          </button>
          <button type="button" className="secondary" onClick={actions.onKeepEditing}>
            {props.secondary ?? "Not yet"}
          </button>
        </div>
      )}
      {!complete && !approved && <p className="quiet small">Some details are missing, so this can't be approved yet.</p>}
      {state.error && <StateNote state={{ kind: "needs-retry", detail: state.error }} />}
    </section>
  );
}

/** The permission to send, asked where he is; after it, he presses Send it on the approval himself. */
function AllowSendBlock({ sourceId, account, actions }: { sourceId: string; account: string; actions: ThreadActions }) {
  const state = (actions.useSendingState ?? noStatus)(sourceId);
  const allow = actions.onAllowSend;
  return <AllowSending account={account} state={state} {...(allow ? { onAllow: () => allow(sourceId) } : {})} next="Press Send it on the approval above." />;
}

/** One approved send, followed live: its real stages (four for a document, two for a reply), then the receipt once it is checked. */
function DeliveryBlock({ actionId, actions }: { actionId: string; actions: ThreadActions }) {
  const status = (actions.useDeliveryStatus ?? noStatus)(actionId);
  if (status === undefined) return <StateNote state={{ kind: "loading", detail: "Reading where the send is…" }} />;
  const steps = deliverySteps(status);
  return (
    <>
      <WorkBlock
        props={{ steps, ...(status.state === "unknown" ? { retry: true } : {}) }}
        {...(actions.onCheckAgain ? { onRetry: () => actions.onCheckAgain!(actionId) } : {})}
        retryLabel="Check again"
      />
      {status.state === "failed" && <p className="say-text">Nothing was sent, and your draft is kept as it is.</p>}
      {status.verified && (
        <ReceiptBlock
          props={{
            text: `Sent to ${status.recipient}: “${status.subject ?? ""}”`,
            at: status.sentAt ?? Date.now(),
            check: "it arrived",
            ...(status.filename ? { document: status.filename } : {}),
            ...(status.link ? { link: status.link } : {}),
          }}
        />
      )}
    </>
  );
}

function ReceiptBlock({ props }: { props: Partial<BlockProps<"receipt">> }) {
  return (
    <div className="receipt chat-receipt" role="status">
      <StateNote state={{ kind: "done", detail: props.text ?? "Done." }} />
      {props.document &&
        (props.link ? (
          <a className="receipt-doc" href={props.link} target="_blank" rel="noreferrer noopener">
            {props.document}
          </a>
        ) : (
          <span className="receipt-doc">{props.document}</span>
        ))}
      <p className="quiet small">
        {props.at !== undefined ? formatWhen(new Date(props.at).toISOString()) : ""}
        {props.check ? ` · Checked: ${props.check}` : ""}
      </p>
    </div>
  );
}
