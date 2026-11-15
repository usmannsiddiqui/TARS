// One project, chat first: the thread with TARS (generative-UI messages) and the composer with
// dictation docked at the bottom; beside it the editable draft (the run-through as timed segments,
// direct edits, Undo and its share link) and commitments grouped by who holds them. Sending happens
// in one place only: the approval in the thread. Presentational: data and actions arrive as props.
import { useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { stripEvidenceIds, type DeliveryStatus } from "@companion/domain/thread";
import { Composer } from "./Composer";
import { PaneSlot } from "./Shell";
import { segmentsOf, setSegment, type Commitment, type Honest, type Prepared, type ThreadMessage } from "./model";
import { Thread, type ApproveArgs } from "./Thread";
import { formatWhen, reason, scrollWithin, StateNote } from "./ui";

export type ArtifactView = {
  id: string;
  revision: string;
  text: string;
  userEdited: boolean;
  suggestions: { id: string; kind: "revision" | "source"; changeSummary: string; baseRevision: string }[];
};
/** The draft's read-only link: state undefined while loading, null while private. */
export type Sharing = {
  state: { link: string; revision: string; sharedAt: number } | null | undefined;
  share(revision: string): Promise<void>;
  update(revision: string): Promise<void>;
  stop(): Promise<void>;
};
export type RevisionOutcome = { status: "applied" | "conflict"; changeSummary: string; undoRevision?: string; revision: string };

export type EditorActions = {
  create(): Promise<void>;
  save(text: string, baseRevision: string): Promise<RevisionOutcome>;
  undo(expectedCurrent: string, undoRevision: string): Promise<RevisionOutcome>;
  applySuggestion(suggestionId: string, baseRevision: string): Promise<RevisionOutcome>;
  dismissSuggestion(suggestionId: string): Promise<void>;
};

/** The chat's backend: his message goes to TARS; the approval's primary action sends (thread.send). */
export type ChatActions = {
  send(text: string): Promise<void>;
  approve(args: ApproveArgs): Promise<void>;
  retry(messageId: string): Promise<void>;
  /** A hook: one send's live delivery.status. */
  useDeliveryStatus(actionId: string): DeliveryStatus | undefined;
  /** Look an unconfirmed send up again; never resends. */
  checkAgain(actionId: string): Promise<void>;
  /** A hook: whether sending from this source is allowed. */
  useSendingState(sourceId: string): "allowed" | "not-allowed" | undefined;
  /** His consent to send from this source; it sends nothing. */
  allowSend(sourceId: string): Promise<void>;
};

export type ProjectViewProps = {
  projectId: string;
  /** "improve" puts the caret in the composer. */
  mode?: "help" | "improve";
  /** undefined = nothing prepared yet; `preparedState` overrides with loading / retry states. */
  prepared?: Prepared;
  preparedState?: Honest;
  /** undefined while loading. */
  thread: ThreadMessage[] | undefined;
  chat: ChatActions;
  commitments: Commitment[] | null;
  /** undefined while loading, null before a run-through exists. */
  artifact: ArtifactView | null | undefined;
  editor: EditorActions;
  sharing: Sharing;
  /** "I did this myself": recorded as reported by you, never as verified. */
  onReportDone(taskId: string): Promise<void>;
  onPrepare(): Promise<void>;
};

export function ProjectView(props: ProjectViewProps) {
  const { prepared, commitments } = props;
  const work = prepared?.work;
  const [preparing, setPreparing] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const mine = commitments?.filter((c) => c.ownership === "user") ?? [];
  const doneMine = mine.filter((c) => c.state === "user-reported-done" || c.state === "verified-done");
  const complete = mine.length > 0 && doneMine.length === mine.length;
  const lastDone = doneMine.at(-1);
  // Every task of yours is done: verified by a checked send, or reported by you (and said so).
  const doneText = complete && lastDone ? `${lastDone.text}${lastDone.state === "user-reported-done" ? " (reported by you, not verified)" : ", verified."}` : null;
  // Done while he is here (a send just checked): bring it into view and focus once, starting nothing.
  const doneRef = useRef<HTMLHeadingElement>(null);
  const wasComplete = useRef(complete);
  useEffect(() => {
    if (complete && !wasComplete.current) doneRef.current?.focus();
    wasComplete.current = complete;
  }, [complete]);

  // "Open draft" and "Keep editing" bring the editable draft into view with its text box focused.
  const draftRef = useRef<HTMLDivElement>(null);
  const pane = useContext(PaneSlot);
  const openDraft = () => {
    pane.open(); // below 1024px the desk pane is an overlay: open it first
    scrollWithin(draftRef.current, ".pane", "start", true);
    draftRef.current?.querySelector<HTMLElement>("textarea.doc, .segment-title")?.focus({ preventScroll: true });
  };

  async function prepare() {
    setPreparing({ busy: true });
    try {
      await props.onPrepare();
      setPreparing({ busy: false });
    } catch (err) {
      setPreparing({ busy: false, error: reason(err) });
    }
  }

  const preparedState: Honest | null =
    props.preparedState ??
    (prepared === undefined
      ? null
      : prepared.status === "needs-retry"
        ? { kind: "needs-retry", detail: "The last preparation failed; the earlier version is kept." }
        : prepared.status === "invalidated"
          ? { kind: "partial", detail: "Something it relied on was forgotten, so it was removed." }
          : null);

  const openItems = commitments?.filter((c) => c.state === "open" || c.state === "waiting").length;
  return (
    <div className="screen chat-screen project">
      <section className="chat-scroll" aria-label="Chat with TARS">
          {doneText && (
            <section className="completion" aria-labelledby="done-h">
              <h2 id="done-h" ref={doneRef} tabIndex={-1}>
                Done
              </h2>
              <p className="completion-what">{doneText}</p>
              <p className="quiet small">Nothing else starts on its own. Stop for now is at the top whenever you want it.</p>
            </section>
          )}
          {preparedState && <StateNote state={preparedState} />}
          {props.thread === undefined ? (
            <StateNote state={{ kind: "loading", detail: "Reading this project's conversation…" }} />
          ) : props.thread.length === 0 ? (
            <div className="thread-empty">
              <p className="say-text">Nothing here yet. When a message asks you for something with a deadline, I start the work and write to you here first.</p>
              <p className="quiet">You can also ask me about this project now, or tell me what to draft.</p>
              {work === undefined && (
                <button type="button" className="secondary" onClick={() => void prepare()} disabled={preparing.busy}>
                  {preparing.busy ? "Preparing…" : prepared?.status === "needs-retry" ? "Try preparing again" : "Prepare from my sources"}
                </button>
              )}
              {preparing.error && <StateNote state={{ kind: "needs-retry", detail: preparing.error }} />}
            </div>
          ) : (
            <Thread
              messages={props.thread}
              actions={{
                onApprove: props.chat.approve,
                onRetry: props.chat.retry,
                onOpenDraft: openDraft,
                onKeepEditing: openDraft,
                onUndo: async (artifactId, expectedCurrent, undoRevision) => void (artifactId === props.artifact?.id && (await props.editor.undo(expectedCurrent, undoRevision))),
                useDeliveryStatus: props.chat.useDeliveryStatus,
                onCheckAgain: props.chat.checkAgain,
                useSendingState: props.chat.useSendingState,
                onAllowSend: props.chat.allowSend,
              }}
            />
          )}
      </section>
      <div className="dock">
        <Composer pill projectId={props.projectId} send={props.chat.send} autoFocus={props.mode === "improve"} />
      </div>
      {pane.slot &&
        createPortal(
          <div className="pane-project" ref={draftRef}>
            <RunThrough artifact={props.artifact && { ...props.artifact, text: stripEvidenceIds(props.artifact.text) }} canCreate={work !== undefined} editor={props.editor} sharing={props.sharing} />
            <details className="open-items">
              <summary>
                Open items {openItems !== undefined && <span className="count num">{openItems}</span>}
              </summary>
              <Commitments commitments={commitments} onReportDone={props.onReportDone} />
            </details>
          </div>,
          pane.slot,
        )}
    </div>
  );
}

function Commitments({ commitments, onReportDone }: { commitments: Commitment[] | null; onReportDone(taskId: string): Promise<void> }) {
  const [state, setState] = useState<{ busy?: string; error?: string }>({});
  if (commitments === null) {
    return (
      <section className="block" aria-labelledby="commit-h">
        <h2 id="commit-h" className="block-title">
          Commitments
        </h2>
        <StateNote state={{ kind: "loading" }} />
      </section>
    );
  }
  const groups: { title: string; items: Commitment[]; empty: string }[] = [
    { title: "Yours", items: commitments.filter((c) => c.ownership === "user"), empty: "Nothing on you here." },
    { title: "Waiting on someone", items: commitments.filter((c) => c.ownership === "other"), empty: "Nobody owes you anything here." },
    { title: "Context, nobody's yet", items: commitments.filter((c) => c.ownership === "unassigned"), empty: "No loose suggestions." },
  ];
  return (
    <section className="block" aria-labelledby="commit-h">
      <h2 id="commit-h" className="block-title">
        Commitments
      </h2>
      {groups.map((g) => (
        <section key={g.title} className="commit-group" aria-label={g.title}>
          <h3 className="group-title">
            {g.title} <span className="count num">{g.items.length}</span>
          </h3>
          {g.items.length === 0 ? (
            <p className="quiet">{g.empty}</p>
          ) : (
            <ul className="plain">
              {g.items.map((c) => (
                <li key={c.id} data-done={c.state.endsWith("done") || undefined}>
                  {c.text}
                  <span className="quiet">
                    {c.dueAt && ` · due ${formatWhen(c.dueAt)}`}
                    {c.state === "verified-done" && " · done, verified"}
                    {c.state === "user-reported-done" && " · reported done by you, not verified"}
                  </span>
                  {c.ownership === "user" && c.state === "open" && (
                    <button
                      type="button"
                      className="text-button inline done-myself"
                      disabled={state.busy !== undefined}
                      aria-label={`I did this myself: ${c.text}`}
                      onClick={async () => {
                        setState({ busy: c.id });
                        try {
                          await onReportDone(c.id);
                          setState({});
                        } catch (err) {
                          setState({ error: reason(err) });
                        }
                      }}
                    >
                      I did this myself
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      {state.error && <StateNote state={{ kind: "needs-retry", detail: state.error }} />}
    </section>
  );
}

type LastChange = { summary: string; revision: string; undoRevision?: string; conflict?: boolean };

type RunThroughProps = {
  artifact: ArtifactView | null | undefined;
  canCreate: boolean;
  editor: EditorActions;
  sharing: Sharing;
};

function RunThrough({ artifact, canCreate, editor, sharing }: RunThroughProps) {
  const textId = useId();
  // `loaded` is the revision the draft started from; saves name it, so a newer cloud text is never overwritten.
  const [loaded, setLoaded] = useState({ revision: artifact?.revision, text: artifact?.text ?? "" });
  const [draft, setDraft] = useState(artifact?.text ?? "");
  const [last, setLast] = useState<LastChange | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft !== loaded.text;

  // A new cloud revision replaces the text only when it would not discard unsaved edits.
  useEffect(() => {
    if (!artifact || artifact.revision === loaded.revision) return;
    if (draft === loaded.text || draft === artifact.text) {
      setLoaded({ revision: artifact.revision, text: artifact.text });
      setDraft(artifact.text);
    }
  }, [artifact, loaded, draft]);

  async function run(label: string, action: () => Promise<RevisionOutcome | void>) {
    setBusy(label);
    setError(null);
    try {
      const outcome = await action();
      if (outcome) {
        setLast({ summary: outcome.changeSummary, revision: outcome.revision, conflict: outcome.status === "conflict", ...(outcome.undoRevision ? { undoRevision: outcome.undoRevision } : {}) });
      }
    } catch (err) {
      setError(reason(err));
    } finally {
      setBusy(null);
    }
  }

  const segments = segmentsOf(draft);
  const total = segments.reduce((n, seg) => n + seg.minutes, 0);
  const edit = (line: number, next: { title: string; minutes: number }) => setDraft((text) => setSegment(text, line, next));

  return (
    <section className="block editor run" aria-labelledby="run-h">
      <h2 id="run-h" className="block-title">
        Run-through
      </h2>
      {segments.length > 0 && (
        <p className="run-total">
          <span className="run-total-num num">{total}</span> min in {segments.length} segments
        </p>
      )}
      {artifact === undefined ? (
        <StateNote state={{ kind: "loading", detail: "Reading the run-through…" }} />
      ) : artifact === null ? (
        <div className="run-empty">
          {canCreate ? (
            <button type="button" className="secondary" disabled={busy !== null} onClick={() => run("create", editor.create)}>
              {busy === "create" ? "Creating…" : "Start the run-through"}
            </button>
          ) : (
            <p className="quiet small">Nothing prepared yet.</p>
          )}
        </div>
      ) : (
        <>
          {artifact.suggestions.map((s) => (
            <div key={s.id} className="suggestion decision tars-voice" role="group" aria-label="Suggested adjustment">
              <p className="decision-ask">Needs your decision</p>
              <p>
                <span className="why">{s.kind === "source" ? "A source changed:" : "Suggested:"}</span> {s.changeSummary}
              </p>
              <div className="actions">
                <button type="button" className="secondary" disabled={busy !== null || dirty} onClick={() => run("apply", () => editor.applySuggestion(s.id, artifact.revision))}>
                  Apply
                </button>
                <button type="button" className="text-button" disabled={busy !== null} onClick={() => run("dismiss", () => editor.dismissSuggestion(s.id))}>
                  Dismiss
                </button>
              </div>
              <p className="quiet small">{dirty ? "Save your edits first; applying works on the saved revision." : "Nothing changes until you choose."}</p>
            </div>
          ))}

          {segments.length > 0 && (
            <>
              <div className="run-tape" aria-hidden="true">
                {segments.map((seg) => (
                  <span key={seg.line} style={{ flexGrow: Math.max(seg.minutes, 0.5) }} />
                ))}
              </div>
              <ol className="segments" aria-label="Segments">
                {segments.map((seg, i) => (
                  <li key={seg.line} className="segment">
                    <label htmlFor={`${textId}-t${seg.line}`} className="sr-only">
                      Segment {i + 1} title
                    </label>
                    {/* A one-line title that wraps in the narrow pane: Return never adds a line. */}
                    <textarea
                      id={`${textId}-t${seg.line}`}
                      className="segment-title"
                      rows={1}
                      value={seg.title}
                      maxLength={200}
                      onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
                      onChange={(e) => edit(seg.line, { title: e.target.value.replace(/\s*\n\s*/g, " "), minutes: seg.minutes })}
                    />
                    <label htmlFor={`${textId}-m${seg.line}`} className="sr-only">
                      Minutes for segment {i + 1}
                    </label>
                    <span className="segment-min">
                      <input
                        id={`${textId}-m${seg.line}`}
                        className="num"
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={999}
                        value={seg.minutes}
                        onChange={(e) => {
                          const minutes = Number(e.target.value);
                          if (e.target.value !== "" && Number.isInteger(minutes) && minutes >= 0 && minutes <= 999) edit(seg.line, { title: seg.title, minutes });
                        }}
                      />
                      <span aria-hidden="true">min</span>
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}

          <details className="run-text" open={segments.length === 0 || undefined}>
            <summary>{segments.length > 0 ? "Full text, with notes between segments" : "Full text"}</summary>
            <label htmlFor={textId} className="sr-only">
              Run-through text
            </label>
            <textarea id={textId} className="doc" value={draft} rows={10} onChange={(e) => setDraft(e.target.value)} />
          </details>
          <div className="editor-bar">
            <span className="quiet">{dirty ? "Unsaved edits" : artifact.userEdited ? `Revision ${artifact.revision}, edited by you` : `Revision ${artifact.revision}`}</span>
            <button type="button" className="secondary" disabled={!dirty || busy !== null} onClick={() => run("save", () => editor.save(draft, loaded.revision ?? artifact.revision))}>
              {busy === "save" ? "Saving…" : "Save edits"}
            </button>
          </div>

          {last && (
            <div className="change" role="status">
              <p>
                <span className="why">{last.conflict ? "Not changed:" : "Changed:"}</span> {last.summary}
              </p>
              {last.undoRevision && !last.conflict && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy !== null || dirty}
                  onClick={() => run("undo", () => editor.undo(last.revision, last.undoRevision!))}
                >
                  Undo
                </button>
              )}
            </div>
          )}

          <ShareLink revision={artifact.revision} dirty={dirty} sharing={sharing} />
        </>
      )}
      {error && <StateNote state={{ kind: "needs-retry", detail: error }} />}
    </section>
  );
}

/** Sharing is the user's outside act: one read-only link to one saved revision, moved only when they say so. */
function ShareLink({ revision, dirty, sharing }: { revision: string; dirty: boolean; sharing: Sharing }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Honest | null>(null);
  const { state } = sharing;

  async function run(name: string, action: () => Promise<void>, done?: string) {
    setBusy(name);
    setNote(null);
    try {
      await action();
      if (done) setNote({ kind: "done", detail: done });
    } catch (err) {
      setNote({ kind: "needs-retry", detail: reason(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="act share" aria-labelledby="share-h">
      <h3 id="share-h" className="group-title">
        Share by link
      </h3>
      {state === undefined ? (
        <StateNote state={{ kind: "loading", detail: "Reading whether this draft is shared…" }} />
      ) : state === null ? (
        <div className="act-confirm">
          <p className="quiet small">{dirty ? "Save your edits first; only a saved revision is shared." : "Private. A link lets anyone who has it read this revision."}</p>
          <button type="button" className="secondary" disabled={dirty || busy !== null} onClick={() => run("share", () => sharing.share(revision))}>
            {busy === "share" ? "Sharing…" : `Share revision ${revision}`}
          </button>
        </div>
      ) : (
        <>
          <StateNote state={{ kind: "shared", detail: `Revision ${state.revision}, ${formatWhen(new Date(state.sharedAt).toISOString())}. Anyone with the link can read it.` }} />
          <div className="editor-bar">
            <button type="button" className="secondary" disabled={busy !== null} onClick={() => run("copy", () => navigator.clipboard.writeText(state.link), "Link copied.")}>
              Copy link
            </button>
            {state.revision !== revision && (
              <button
                type="button"
                className="secondary"
                disabled={dirty || busy !== null}
                onClick={() => run("update", () => sharing.update(revision), `The shared page now shows revision ${revision}.`)}
              >
                {busy === "update" ? "Updating…" : `Update to revision ${revision}`}
              </button>
            )}
            <button type="button" className="text-button" disabled={busy !== null} onClick={() => run("stop", sharing.stop, "Sharing stopped. The old link no longer opens anything.")}>
              {busy === "stop" ? "Stopping…" : "Stop sharing"}
            </button>
          </div>
        </>
      )}
      {note && <StateNote state={note} />}
    </section>
  );
}
