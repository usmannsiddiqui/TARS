// One project: prepared work with its sources and gaps, the editable run-through, and commitments
// grouped by who holds them. Presentational: data and actions arrive as props.
import { useEffect, useId, useRef, useState } from "react";
import type { Commitment, Evidence, Honest, Prepared } from "./model";
import { formatWhen, reason, StateNote } from "./ui";

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
  onMakeFocus(): void;
  onPrepare(): Promise<void>;
  onStop(): void;
};

export function ProjectView(props: ProjectViewProps) {
  const { prepared, commitments } = props;
  const work = prepared?.work;
  const [helping, setHelping] = useState(props.mode === "help");
  const [preparing, setPreparing] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const evidenceById = new Map(props.evidence.map((e) => [e.id, e]));
  const mine = commitments?.filter((c) => c.ownership === "user") ?? [];
  const doneMine = mine.filter((c) => c.state === "user-reported-done" || c.state === "verified-done");
  const complete = mine.length > 0 && doneMine.length === mine.length;

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

  return (
    <div className="screen">
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
      </header>

      {complete && (
        <section className="completion" aria-labelledby="done-h">
          <h2 id="done-h">Done</h2>
          <p>{doneMine.at(-1)?.text}</p>
          <div className="actions equal">
            {work?.nextAction && (
              <button type="button" className="secondary" onClick={() => setHelping(true)}>
                Optional next: {work.nextAction}
              </button>
            )}
            <button type="button" className="secondary" onClick={props.onStop}>
              Stop for now
            </button>
          </div>
        </section>
      )}

      <div className="project-grid">
        <div className="project-main">
          <section className="block" aria-labelledby="prepared-h">
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
                                <span className="quiet">
                                  {" "}
                                  {e.sourceUrl && URL.canParse(e.sourceUrl) ? `${new URL(e.sourceUrl).host} · ` : ""}
                                  {formatWhen(e.occurredAt)}
                                  {e.freshness !== "current" && " · may be out of date"}
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

          <RunThrough artifact={props.artifact} canCreate={work !== undefined} editor={props.editor} improve={props.mode === "improve"} />
        </div>

        <aside className="project-side">
          <section className="block next" aria-labelledby="next-h">
            <h2 id="next-h" className="block-title">
              Next step
            </h2>
            {helping && work ? (
              <p className="step" tabIndex={-1} ref={(el) => el?.focus()}>
                {work.nextAction}
              </p>
            ) : (
              <p className="quiet">One small step, when you want it.</p>
            )}
            {!helping && (
              <button type="button" className="primary" onClick={() => (work ? setHelping(true) : void prepare())} disabled={preparing.busy}>
                Help me start
              </button>
            )}
            {helping && !work && <StateNote state={{ kind: "empty", detail: "Prepare from your sources first, then I can suggest a step." }} />}
          </section>
          <Commitments commitments={commitments} />
        </aside>
      </div>
    </div>
  );
}

function Commitments({ commitments }: { commitments: Commitment[] | null }) {
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
                    {c.state === "user-reported-done" && " · done, by you"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </section>
  );
}

type LastChange = { summary: string; revision: string; undoRevision?: string; conflict?: boolean };

function RunThrough({ artifact, canCreate, editor, improve }: { artifact: ArtifactView | null | undefined; canCreate: boolean; editor: EditorActions; improve: boolean }) {
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

  return (
    <section className="block editor" aria-labelledby="run-h">
      <h2 id="run-h" className="block-title">
        Run-through
      </h2>
      {artifact === undefined ? (
        <StateNote state={{ kind: "loading" }} />
      ) : artifact === null ? (
        <>
          <p className="quiet">An editable copy of the prepared work, yours to change.</p>
          <button type="button" className="secondary" disabled={!canCreate || busy !== null} onClick={() => run("create", editor.create)}>
            {busy === "create" ? "Creating…" : "Start the run-through"}
          </button>
          {!canCreate && <p className="quiet">Available once something is prepared.</p>}
        </>
      ) : (
        <>
          {artifact.suggestions.map((s) => (
            <div key={s.id} className="suggestion" role="group" aria-label="Suggested adjustment">
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
            </div>
          ))}
          <label htmlFor={textId} className="sr-only">
            Run-through text
          </label>
          <textarea id={textId} className="doc" value={draft} rows={12} onChange={(e) => setDraft(e.target.value)} />
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
        </>
      )}
      {error && <StateNote state={{ kind: "needs-retry", detail: error }} />}
    </section>
  );
}
