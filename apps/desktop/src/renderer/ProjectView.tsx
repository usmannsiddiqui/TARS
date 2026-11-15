// One project: its next step in TARS's voice, the run-through as timed segments (the signature: titles
// and minutes edit the text, the total is computed) with its one instructed action, then prepared work
// and commitments grouped by who holds them. Presentational: data and actions arrive as props.
import { useEffect, useId, useRef, useState } from "react";
import { Act, type ActingActions, type LogDestinationView } from "./Act";
import { segmentsOf, setSegment, type Commitment, type Evidence, type Honest, type Prepared, type Receipt } from "./model";
import { UrlChip } from "./logos";
import { formatWhen, reason, StateNote, StateTag } from "./ui";

export type ArtifactView = {
  id: string;
  revision: string;
  text: string;
  userEdited: boolean;
  suggestions: { id: string; kind: "revision" | "source"; changeSummary: string; baseRevision: string }[];
};
export type RevisionOutcome = { status: "applied" | "conflict"; changeSummary: string; undoRevision?: string; revision: string };

export type EditorActions = {
  create(): Promise<void>;
  save(text: string, baseRevision: string): Promise<RevisionOutcome>;
  revise(instruction: string, baseRevision: string): Promise<RevisionOutcome>;
  undo(expectedCurrent: string, undoRevision: string): Promise<RevisionOutcome>;
  applySuggestion(suggestionId: string, baseRevision: string): Promise<RevisionOutcome>;
  dismissSuggestion(suggestionId: string): Promise<void>;
};

export type ProjectViewProps = {
  name: string;
  isFocus: boolean;
  mode?: "help" | "improve";
  /** undefined = nothing prepared yet; `preparedState` overrides with loading / retry states. */
  prepared?: Prepared;
  preparedState?: Honest;
  evidence: Evidence[];
  commitments: Commitment[] | null;
  /** undefined while loading, null before a run-through exists. */
  artifact: ArtifactView | null | undefined;
  editor: EditorActions;
  /** The project's newest action receipt: undefined while loading, null when nothing was done yet. */
  receipt: Receipt | null | undefined;
  acting: ActingActions;
  logDestination: LogDestinationView | null | undefined;
  /** "I did this myself": recorded as reported by you, never as verified. */
  onReportDone(taskId: string): Promise<void>;
  onMakeFocus(): void;
  onPrepare(): Promise<void>;
  onStop(): void;
};

export function ProjectView(props: ProjectViewProps) {
  const { prepared, commitments, receipt } = props;
  const work = prepared?.work;
  const [helping, setHelping] = useState(props.mode === "help");
  const [preparing, setPreparing] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const [acted, setActed] = useState(false);
  const [chosenNext, setChosenNext] = useState<string | null>(null);
  const evidenceById = new Map(props.evidence.map((e) => [e.id, e]));
  const mine = commitments?.filter((c) => c.ownership === "user") ?? [];
  const doneMine = mine.filter((c) => c.state === "user-reported-done" || c.state === "verified-done");
  const complete = mine.length > 0 && doneMine.length === mine.length;
  const openMine = mine.filter((c) => c.state === "open");
  // Done for an action only right after the user acted here; an older receipt stays in its own block.
  const verified = receipt?.state === "succeeded" && acted;
  const lastDone = doneMine.at(-1);
  // What is actually done: the verified action, or every task of yours (marked when you reported it).
  const doneText =
    verified && receipt
      ? `${receipt.kind === "update-note" ? `Updated ${receipt.destination}` : `Sent to ${receipt.destination}`}, verified.`
      : complete && lastDone
        ? `${lastDone.text}${lastDone.state === "user-reported-done" ? " (reported by you, not verified)" : ""}`
        : null;
  // One optional next step: the next open task of yours, if there is one.
  const optionalNext = openMine[0]?.text;
  // A verified completion appears above the run-through: bring it into view and focus once, starting nothing.
  const doneRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (verified) doneRef.current?.focus();
  }, [verified]);

  useEffect(() => setHelping(props.mode === "help"), [props.mode]);

  async function prepare() {
    setPreparing({ busy: true });
    try {
      await props.onPrepare();
      setPreparing({ busy: false });
    } catch (err) {
      setPreparing({ busy: false, error: reason(err) });
    }
  }

  const preparedState: Honest =
    props.preparedState ??
    (prepared === undefined
      ? { kind: "empty", detail: "Nothing prepared for this project yet." }
      : prepared.status === "needs-retry"
        ? { kind: "needs-retry", detail: "The last preparation failed; the earlier version is kept." }
        : prepared.status === "invalidated"
          ? { kind: "partial", detail: "Something it relied on was forgotten, so it was removed." }
          : prepared.status === "empty"
            ? { kind: "empty", detail: "No source items for this project yet." }
            : work?.state === "partial"
              ? { kind: "partial", detail: `Prepared ${formatWhen(prepared.updatedAt)}, with gaps` }
              : { kind: "last-checked", at: prepared.updatedAt });

  // What this project holds right now, from data already on this screen. Nothing is estimated.
  const minutes = props.artifact ? segmentsOf(props.artifact.text).reduce((n, s) => n + s.minutes, 0) : 0;
  const readout: [key: string, value: string][] = [
    ["Prepared", props.preparedState?.kind === "loading" ? "reading" : prepared?.status === "ready" ? formatWhen(prepared.updatedAt) : "not yet"],
    ["Run-through", props.artifact === undefined ? "reading" : props.artifact === null ? "not started" : minutes > 0 ? `${minutes} min` : `revision ${props.artifact.revision}`],
    ["Yours open", commitments === null ? "reading" : String(openMine.length)],
  ];

  return (
    <div className="screen project">
      <header className="screen-head">
        <h1>{props.name}</h1>
        <p className="screen-sub">
          {props.isFocus ? (
            "Your focus"
          ) : (
            <>
              Not your focus.{" "}
              <button type="button" className="text-button inline" onClick={props.onMakeFocus}>
                Work on this now
              </button>
            </>
          )}
        </p>
        <ul className="readout" aria-label="Where this project stands">
          {readout.map(([key, value]) => (
            <li key={key}>
              <span className="readout-key">{key}</span> {value}
            </li>
          ))}
        </ul>
      </header>

      {doneText && (
        <section className="completion" aria-labelledby="done-h">
          <h2 id="done-h" ref={doneRef} tabIndex={-1}>
            Done
          </h2>
          <p className="completion-what">{doneText}</p>
          <p className="quiet small">Nothing else starts on its own.</p>
          <div className="actions equal">
            {optionalNext && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setChosenNext(optionalNext);
                  setHelping(true);
                }}
              >
                Optional next: {optionalNext}
              </button>
            )}
            <button type="button" className="secondary" onClick={props.onStop}>
              Stop for now
            </button>
          </div>
        </section>
      )}

      <section className="block next tars-voice" aria-labelledby="next-h">
        <h2 id="next-h" className="block-title">
          Next step
        </h2>
        <div className="next-body">
          {helping && (chosenNext ?? work) ? (
            <p className="step" tabIndex={-1} ref={(el) => el?.focus()}>
              {chosenNext ?? work?.nextAction}
            </p>
          ) : helping && !work ? (
            <StateNote state={{ kind: "empty", detail: "Prepare from your sources first, then I can suggest a step." }} />
          ) : (
            <p className="quiet">One small step, when you want it.</p>
          )}
          {!helping && (
            <button type="button" className="primary" onClick={() => (work ? setHelping(true) : void prepare())} disabled={preparing.busy}>
              Help me start
            </button>
          )}
        </div>
      </section>

      <div className="project-grid">
        <div className="project-main">
          <RunThrough
            artifact={props.artifact}
            canCreate={work !== undefined}
            editor={props.editor}
            improve={props.mode === "improve"}
            act={{ tasks: openMine.map((c) => ({ id: c.id, text: c.text })), receipt: receipt ?? null, onActed: () => setActed(true), actions: props.acting, logDestination: props.logDestination }}
          />
        </div>

        <aside className="project-side">
          <section className="block tars-voice" aria-labelledby="prepared-h">
            <h2 id="prepared-h" className="block-title">
              Prepared for you
            </h2>
            <StateNote state={preparedState} />
            {work && (
              <article className="prepared">
                <h3 className="prepared-title">{work.title}</h3>
                <p className="prepared-body">{work.body}</p>
                {work.gaps.length > 0 && (
                  <div className="gaps">
                    <h4>Not known yet</h4>
                    <ul className="plain">
                      {work.gaps.map((g) => (
                        <li key={g}>{g}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {work.evidenceIds.length > 0 && (
                  <div className="sources">
                    <h4>From your sources</h4>
                    <ol className="source-list">
                      {work.evidenceIds.map((id) => {
                        const e = evidenceById.get(id);
                        return (
                          <li key={id}>
                            {e ? (
                              <>
                                <q>{e.text.length > 160 ? `${e.text.slice(0, 160)}…` : e.text}</q>
                                <span className="source-meta">
                                  <UrlChip url={e.sourceUrl} />
                                  <span className="quiet small">{formatWhen(e.occurredAt)}</span>
                                  {e.freshness !== "current" && <StateTag state={{ kind: "stale" }} />}
                                </span>
                              </>
                            ) : (
                              <span className="quiet">A source item that is no longer current.</span>
                            )}
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                )}
              </article>
            )}
            {(prepared === undefined || prepared.status !== "ready") && !props.preparedState && (
              <button type="button" className="secondary" onClick={prepare} disabled={preparing.busy}>
                {preparing.busy ? "Preparing…" : prepared?.status === "needs-retry" ? "Try preparing again" : "Prepare from my sources"}
              </button>
            )}
            {preparing.error && <StateNote state={{ kind: "needs-retry", detail: preparing.error }} />}
          </section>
          <Commitments commitments={commitments} onReportDone={props.onReportDone} />
        </aside>
      </div>
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
  improve: boolean;
  act: Omit<Parameters<typeof Act>[0], "saved" | "dirty">;
};

function RunThrough({ artifact, canCreate, editor, improve, act }: RunThroughProps) {
  const textId = useId();
  const instructionId = useId();
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  // `loaded` is the revision the draft started from; saves name it, so a newer cloud text is never overwritten.
  const [loaded, setLoaded] = useState({ revision: artifact?.revision, text: artifact?.text ?? "" });
  const [draft, setDraft] = useState(artifact?.text ?? "");
  const [instruction, setInstruction] = useState("");
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

  useEffect(() => {
    if (improve) instructionRef.current?.focus();
  }, [improve, artifact?.id]);

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
          <p>An editable copy of the prepared work, yours to change.</p>
          <button type="button" className="secondary" disabled={!canCreate || busy !== null} onClick={() => run("create", editor.create)}>
            {busy === "create" ? "Creating…" : "Start the run-through"}
          </button>
          {!canCreate && <StateNote state={{ kind: "empty", detail: "Available once something is prepared." }} />}
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
                    <input id={`${textId}-t${seg.line}`} className="segment-title" value={seg.title} maxLength={200} onChange={(e) => edit(seg.line, { title: e.target.value, minutes: seg.minutes })} />
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

          <form
            className="instruct"
            onSubmit={(e) => {
              e.preventDefault();
              if (instruction.trim() === "") return;
              void run("revise", async () => {
                const outcome = await editor.revise(instruction, artifact.revision);
                if (outcome.status === "applied") setInstruction("");
                return outcome;
              });
            }}
          >
            <label htmlFor={instructionId}>Tell me what to change</label>
            <textarea
              id={instructionId}
              ref={instructionRef}
              rows={2}
              value={instruction}
              placeholder="For example: make the demo part shorter"
              onChange={(e) => setInstruction(e.target.value)}
            />
            <div className="editor-bar">
              <span className="quiet">{dirty ? "Save your edits first, so nothing is overwritten." : "Applies straight away; you can undo it."}</span>
              <button type="submit" className="secondary" disabled={dirty || busy !== null || instruction.trim() === ""}>
                {busy === "revise" ? "Revising…" : "Revise"}
              </button>
            </div>
          </form>

          <Act saved={{ artifactId: artifact.id, revision: artifact.revision, text: artifact.text }} dirty={dirty} {...act} />
        </>
      )}
      {error && <StateNote state={{ kind: "needs-retry", detail: error }} />}
    </section>
  );
}
