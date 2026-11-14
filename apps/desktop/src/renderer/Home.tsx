// Today across every project: one recommended start with its reason, the other ways in, quick
// capture and the full backlog one click away. Presentational: data and actions arrive as props.
import { useId, useState, type FormEvent } from "react";
import type { CapturedIdea, Honest, ProjectSummary, Recommendation } from "./model";
import { reason, StateNote } from "./ui";

export type HomeProps = {
  dateLabel: string;
  /** null while projects are unavailable; `cloud` then says why. */
  projects: ProjectSummary[] | null;
  cloud?: Honest;
  focusProjectId?: string;
  recommendation: Recommendation | null;
  signedIn: boolean;
  ideas: CapturedIdea[];
  onCapture(text: string): Promise<string>;
  onStart(projectId: string, mode: "help" | "improve"): void;
  onOpenProject(projectId: string): void;
  onCreateProject(name: string): Promise<void>;
};

const preparedNote = (p: ProjectSummary): Honest => {
  if (p.prepared === undefined) return { kind: "empty", detail: "Nothing prepared yet" };
  if (p.prepared.status === "needs-retry") return { kind: "needs-retry", detail: "Last preparation failed" };
  if (p.prepared.status === "invalidated") return { kind: "partial", detail: "Something it used was forgotten" };
  if (p.prepared.status === "empty" || !p.prepared.work) return { kind: "empty", detail: "No source items yet" };
  return p.prepared.work.state === "partial" ? { kind: "partial", detail: p.prepared.work.title } : { kind: "done", detail: p.prepared.work.title };
};

export function Home(props: HomeProps) {
  const { projects, recommendation, focusProjectId } = props;
  const recommended = projects?.find((p) => p.id === recommendation?.projectId);
  const others = projects?.filter((p) => p.id !== recommended?.id) ?? [];
  const focusName = projects?.find((p) => p.id === focusProjectId)?.name;
  const backlog = (projects ?? []).map((p) => ({ p, open: p.commitments.filter((c) => c.state === "open" || c.state === "waiting") })).filter((g) => g.open.length > 0);
  const backlogCount = backlog.reduce((n, g) => n + g.open.length, 0);

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Today</h1>
        <p className="screen-sub">
          {props.dateLabel} · {focusName ? `Focus: ${focusName}` : "No project chosen yet"}
        </p>
      </header>

      <div className="home-grid">
        <div className="home-main">
          {projects === null ? (
            <section className="block" aria-labelledby="start-h">
              <h2 id="start-h" className="block-title">
                Recommended start
              </h2>
              <StateNote state={props.cloud ?? { kind: "loading" }} />
              <p className="quiet">You can still capture ideas; they wait safely on this Mac.</p>
            </section>
          ) : projects.length === 0 ? (
            <section className="block" aria-labelledby="start-h">
              <h2 id="start-h" className="block-title">
                Start with a project
              </h2>
              <p>Name the first thing you are working on. You can add the others later.</p>
              <NewProject onCreate={props.onCreateProject} />
            </section>
          ) : (
            <>
              <section className="start" aria-labelledby="start-h">
                <h2 id="start-h" className="block-title">
                  Recommended start
                </h2>
                {recommended && recommendation ? (
                  <>
                    <p className="start-project">{recommended.name}</p>
                    <p className="start-step">{recommended.prepared?.work?.nextAction ?? recommended.prepared?.work?.title ?? "Your place is saved here."}</p>
                    <p className="start-reason">
                      <span className="why">Why this one:</span> {recommendation.reason}
                    </p>
                    <div className="actions">
                      <button type="button" className="primary" onClick={() => props.onStart(recommended.id, "help")}>
                        Help me start
                      </button>
                      <button type="button" className="secondary" onClick={() => props.onStart(recommended.id, "improve")}>
                        Improve content first
                      </button>
                    </div>
                  </>
                ) : (
                  <StateNote state={{ kind: "empty", detail: "Nothing is prepared or due yet. Pick any project below, or capture what is on your mind." }} />
                )}
              </section>

              <section className="block" aria-labelledby="others-h">
                <h2 id="others-h" className="block-title">
                  Other ways to start
                </h2>
                {others.length === 0 ? (
                  <p className="quiet">No other projects.</p>
                ) : (
                  <ul className="rows" aria-labelledby="others-h">
                    {others.map((p) => (
                      <li key={p.id} className="row">
                        <div className="row-main">
                          <span className="row-title">{p.name}</span>
                          <StateNote state={preparedNote(p)} />
                        </div>
                        <button type="button" className="text-button" onClick={() => props.onOpenProject(p.id)} aria-label={`Open ${p.name}`}>
                          Open
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <NewProject onCreate={props.onCreateProject} compact />
              </section>

              <details className="block backlog">
                <summary>
                  All open work <span className="count num">{backlogCount}</span>
                </summary>
                {backlog.length === 0 ? (
                  <p className="quiet">Nothing open across your projects.</p>
                ) : (
                  backlog.map(({ p, open }) => (
                    <section key={p.id} aria-label={`Open work in ${p.name}`}>
                      <h3 className="group-title">{p.name}</h3>
                      <ul className="plain">
                        {open.map((c) => (
                          <li key={c.id}>
                            {c.text}
                            {c.state === "waiting" && <span className="quiet"> · waiting on someone</span>}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))
                )}
              </details>
            </>
          )}
        </div>

        <aside className="home-side">
          <Capture signedIn={props.signedIn} onCapture={props.onCapture} />
          <section className="block" aria-labelledby="ideas-h">
            <h2 id="ideas-h" className="block-title">
              Captured ideas
            </h2>
            <p className="quiet">Saved on this Mac. Capturing never changes your focus.</p>
            {props.ideas.length === 0 ? (
              <StateNote state={{ kind: "empty", detail: "No ideas captured yet." }} />
            ) : (
              <ul className="ideas" aria-label="Captured ideas">
                {props.ideas.map((idea, i) => (
                  <li key={i}>{idea.text}</li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function Capture({ signedIn, onCapture }: { signedIn: boolean; onCapture(text: string): Promise<string> }) {
  const id = useId();
  const [text, setText] = useState("");
  const [status, setStatus] = useState<{ kind: "idle" | "busy" } | { kind: "saved"; summary: string } | { kind: "error"; message: string }>({ kind: "idle" });

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (text.trim() === "" || status.kind === "busy") return;
    setStatus({ kind: "busy" });
    try {
      const summary = await onCapture(text);
      setText("");
      setStatus({ kind: "saved", summary });
    } catch (err) {
      setStatus({ kind: "error", message: reason(err) });
    }
  }

  return (
    <form className="capture" onSubmit={submit} aria-label="Quick capture">
      <label htmlFor={id} className="block-title">
        Capture an idea
      </label>
      {signedIn ? (
        <>
          <textarea
            id={id}
            value={text}
            rows={3}
            placeholder="Whatever is on your mind. It will not start anything."
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
            }}
          />
          <div className="capture-foot">
            <span className="hint">⌘ Return saves</span>
            <button type="submit" className="secondary" disabled={status.kind === "busy" || text.trim() === ""}>
              Save
            </button>
          </div>
        </>
      ) : (
        <StateNote state={{ kind: "not-signed-in", detail: "Sign in to keep captures on this Mac." }} />
      )}
      <p role="status" aria-live="polite" className="capture-status">
        {status.kind === "busy" && "Saving…"}
        {status.kind === "saved" && `Saved on this Mac: ${status.summary}`}
        {status.kind === "error" && `Not saved: ${status.message}`}
      </p>
    </form>
  );
}

function NewProject({ onCreate, compact }: { onCreate(name: string): Promise<void>; compact?: boolean }) {
  const id = useId();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onCreate(name);
      setName("");
    } catch (err) {
      setError(reason(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className={compact ? "new-project compact" : "new-project"} onSubmit={submit}>
      <label htmlFor={id}>{compact ? "Add a project" : "Project name"}</label>
      <div className="inline-field">
        <input id={id} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="secondary" disabled={busy || name.trim() === ""}>
          Add
        </button>
      </div>
      {error && <p role="alert" className="field-error">{error}</p>}
    </form>
  );
}
