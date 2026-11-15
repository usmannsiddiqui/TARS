// The project chat thread. TARS's messages are generative UI: each one is a list of block specs from
// the catalog (packages/domain/src/thread.ts), rendered from any spec and updated in place as the
// subscription moves it (stable keys, so changes animate instead of popping). Blocks emit named
// actions with ids; none of them sends, shares or acts by itself. Presentational: data and actions
// arrive as props.
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import {
  blockHasContent,
  deliverySteps,
  stripEvidenceIds,
  formatDuration,
  isMailAddress,
  viewBlock,
  workSummary,
  type BlockProps,
  type BlockView,
  type DeliveryStatus,
  type Step,
} from "@companion/domain/thread";
import { SourceChip } from "./logos";
import { AllowSending, formatWhen, reason, SOURCE_NAME, StateNote, StateTag } from "./ui";

export type ThreadMessage = { id: string; role: "tars" | "user"; text?: string; blocks: unknown[]; createdAt: number };
export type ApproveArgs = { projectId: string; artifactId: string; revision: string; commitmentKey: string; recipient: string };
export type ThreadActions = {
  /** The approval's primary action: send this revision to the recipient as he left the field (thread.send). */
  onApprove(args: ApproveArgs): Promise<void>;
  onKeepEditing(): void;
  onOpenDraft(): void;
  onUndo(artifactId: string, expectedCurrent: string, undoRevision: string): Promise<void>;
  onRetry(messageId: string): Promise<void>;
  /** A hook: the live delivery.status of one send (undefined while loading). */
  useDeliveryStatus(actionId: string): DeliveryStatus | undefined;
  /** "Check again" for an unconfirmed send: looks it up, never resends. */
  onCheckAgain(actionId: string): Promise<void>;
  /** A hook: whether sending from this source is allowed (undefined while loading). */
  useSendingState(sourceId: string): "allowed" | "not-allowed" | undefined;
  /** The user's consent to send from this source (composio.allowSend); it never sends. */
  onAllowSend(sourceId: string): Promise<void>;
};

export function Thread({ messages, actions }: { messages: ThreadMessage[]; actions: ThreadActions }) {
  const end = useRef<HTMLLIElement>(null);
  const last = messages.at(-1);
  // Opened from a notification or a card: at the latest message. New messages bring it into view.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" }); // braces: Chromium's scrollIntoView returns a Promise, not a cleanup
  }, [messages.length, last?.blocks.length]);
  const views = messages.map((m) => ({ ...m, views: m.blocks.map(viewBlock) }));
  // What was already there when the thread opened just renders; only what arrives later opens its space.
  const [shown] = useState(() => new Set(views.flatMap((m) => [m.id, ...m.views.map((b) => `${m.id}/${b.id}`)])));
  // ⌘↵ approves only the newest open approval, and only from outside a text box with words in it.
  const open = views.findLast((m) => m.views.some((b) => b.type === "approval" && b.props.state === "open"));
  return (
    <ol className="thread" aria-label="Conversation with TARS" aria-live="polite" aria-relevant="additions text">
      {views.map((m) => (
        <li
          key={m.id}
          className="msg"
          data-role={m.role}
          data-new={shown.has(m.id) ? undefined : ""}
          ref={m === views.at(-1) ? end : undefined}
          onAnimationEnd={(e) => {
            if (e.currentTarget === end.current && e.animationName === "helper-open") e.currentTarget.scrollIntoView({ block: "end" });
          }}
        >
          {m.role === "user" ? (
            <p className="msg-user inner">
              <span className="sr-only">You: </span>
              {m.text}
            </p>
          ) : (
            <div className="msg-tars">
              <span className="sr-only">TARS: </span>
              {m.views.map((b) => (
                <BlockSlot key={b.id} block={b} messageId={m.id} actions={actions} hotkey={m === open} arrived={!shown.has(`${m.id}/${b.id}`)} />
              ))}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

function BlockSlot({ block, messageId, actions, hotkey, arrived }: { block: BlockView; messageId: string; actions: ThreadActions; hotkey: boolean; arrived: boolean }) {
  if (!blockHasContent(block)) return null; // nothing to show: no empty card
  return (
    <div className="block-slot" data-type={block.type} data-new={arrived ? "" : undefined}>
      {block.type === "work" ? (
        <WorkBlock props={block.props} onRetry={() => actions.onRetry(messageId)} />
      ) : block.type === "document" ? (
        <DocumentBlock props={block.props} actions={actions} />
      ) : block.type === "say" ? (
        <SayBlock props={block.props} />
      ) : block.type === "approval" ? (
        <ApprovalBlock props={block.props} complete={block.complete} actions={actions} hotkey={hotkey} />
      ) : block.type === "receipt" ? (
        <ReceiptBlock props={block.props} />
      ) : block.type === "allowSend" && block.props.sourceId ? (
        <AllowSendBlock sourceId={block.props.sourceId} account={block.props.account ?? "Gmail"} actions={actions} />
      ) : block.type === "delivery" && block.props.actionId ? (
        <DeliveryBlock actionId={block.props.actionId} actions={actions} />
      ) : (
        <p className="quiet small">This part of the message can't be shown here.</p>
      )}
    </div>
  );
}

const MARK: Record<Step["status"], string> = { done: "done", running: "now", waiting: "next", failed: "failed", unknown: "next" };

/** A running clock in CSS from the step's real start (no JS timer): the tape counter, started in the past. */
function Clock({ since }: { since: number }) {
  return <span className="tape-run" style={{ animationDelay: `${-(Date.now() - since)}ms` } as CSSProperties} aria-hidden="true" />;
}

function WorkBlock({ props, onRetry, retryLabel = "Try again" }: { props: Partial<BlockProps<"work">>; onRetry(): Promise<void>; retryLabel?: string }) {
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
      {props.retry && (
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
        <button type="button" className="secondary" onClick={actions.onOpenDraft}>
          Open draft
        </button>
        {artifactId && revision && undoRevision && !state.undone && (
          <button
            type="button"
            className="text-button"
            disabled={state.busy}
            onClick={async () => {
              setState({ busy: true });
              try {
                await actions.onUndo(artifactId, revision, undoRevision);
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
  return (
    <div className="say">
      <p className="say-text">{props.text ? stripEvidenceIds(props.text) : <span className="quiet">…</span>}</p>
      {props.sources && props.sources.length > 0 && (
        <p className="say-sources" aria-label="From your sources">
          {props.sources.map((s) => (
            <SourceChip key={s.id} kind="link" label={s.label} />
          ))}
        </p>
      )}
    </div>
  );
}

function ApprovalBlock({ props, complete, actions, hotkey }: { props: Partial<BlockProps<"approval">>; complete: boolean; actions: ThreadActions; hotkey: boolean }) {
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
    if (!ready || state.busy) return;
    setState({ busy: true });
    try {
      await actions.onApprove({ projectId, artifactId, revision, commitmentKey, recipient: address });
      setState({ busy: false });
    } catch (err) {
      setState({ busy: false, error: reason(err) });
    }
  };
  const approveRef = useRef(approve);
  approveRef.current = approve;
  useEffect(() => {
    if (!hotkey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
      const el = document.activeElement;
      if (el instanceof HTMLTextAreaElement && el.value.trim() !== "") return; // ⌘↵ there sends the message
      e.preventDefault();
      void approveRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkey]);
  const problem = touched && !valid ? (address === "" ? "Add the address to send it to." : "Use one plain email address, like name@example.com.") : null;
  return (
    <section className="approval block tars-voice" aria-labelledby={headId} data-state={props.state}>
      <h3 id={headId} className="block-title">
        {approved ? "Approved" : "Before it goes out"}
      </h3>
      <p className="approval-what">
        A Word document of {props.document ? `“${props.document}”` : "the draft"}, revision {revision ?? "not known"}, sent as a link by email.
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
          <button type="button" className="primary" disabled={!complete || state.busy} onClick={() => void approve()} aria-keyshortcuts="Meta+Enter">
            {state.busy ? "Sending…" : (props.primary ?? "Send it")}
            <kbd className="approval-key" aria-hidden="true">
              ⌘↵
            </kbd>
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
  const state = actions.useSendingState(sourceId);
  return <AllowSending account={account} state={state} onAllow={() => actions.onAllowSend(sourceId)} next="Press Send it on the approval above." />;
}

/** One approved send, followed live: its four real stages, then the receipt once it is checked. */
function DeliveryBlock({ actionId, actions }: { actionId: string; actions: ThreadActions }) {
  const status = actions.useDeliveryStatus(actionId);
  if (status === undefined) return <StateNote state={{ kind: "loading", detail: "Reading where the send is…" }} />;
  const steps = deliverySteps(status);
  return (
    <>
      <WorkBlock props={{ steps, ...(status.state === "unknown" ? { retry: true } : {}) }} onRetry={() => actions.onCheckAgain(actionId)} retryLabel="Check again" />
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
