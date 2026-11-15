// "What I remember": facts with their sources, correct, forget, and items withheld for review.
// Presentational: data and actions arrive as props.
import { useId, useState } from "react";
import type { Evidence, Fact, Honest, Withheld } from "./model";
import { UrlChip } from "./logos";
import { formatWhen, reason, StateNote, StateTag } from "./ui";

export type MemoryViewProps = {
  projects: { id: string; name: string }[];
  projectId?: string;
  state?: Honest;
  facts: Fact[];
  withheld: Withheld[];
  evidence: Evidence[];
  onSelectProject(projectId: string): void;
  onCorrect(fact: Fact, value: string): Promise<void>;
  onForget(fact: Fact): Promise<void>;
  /** Lift a forget made here, so the key may be learned again from your sources. */
  onAllowRelearning(fact: Fact): Promise<void>;
  /** Use a withheld item: remembered, and the forget it resembles is lifted. */
  onAccept(item: Withheld): Promise<void>;
  /** Drop a withheld item from review; it stays unused. */
  onDismiss(item: Withheld): Promise<void>;
};

const humanKey = (key: string) => key.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function MemoryView(props: MemoryViewProps) {
  const pickerId = useId();
  const byId = new Map(props.evidence.map((e) => [e.id, e]));
  const projectName = props.projects.find((p) => p.id === props.projectId)?.name;
  // Forgets made in this window; the backend keeps no readable list of them, so only these can be lifted here.
  const [forgotten, setForgotten] = useState<{ fact: Fact; busy?: boolean; lifted?: boolean; error?: string }[]>([]);
  const forget = async (fact: Fact) => {
    await props.onForget(fact);
    setForgotten((list) => [...list.filter((f) => f.fact.id !== fact.id), { fact }]);
  };
  const relearn = async (fact: Fact) => {
    const mark = (patch: { busy?: boolean; lifted?: boolean; error?: string }) => setForgotten((list) => list.map((f) => (f.fact.id === fact.id ? { fact, ...patch } : f)));
    mark({ busy: true });
    try {
      await props.onAllowRelearning(fact);
      mark({ lifted: true });
    } catch (err) {
      mark({ error: reason(err) });
    }
  };
  const groups = [
    { title: projectName ? `In ${projectName}` : "In this project", facts: props.facts.filter((f) => f.scope === "project") },
    { title: "Everywhere", facts: props.facts.filter((f) => f.scope === "global") },
  ].filter((g) => g.facts.length > 0);

  return (
    <div className="screen memory">
      <header className="screen-head">
        <h1>What I remember</h1>
        <p className="screen-sub">
          {projectName ? `In ${projectName}, plus anything you asked me to remember everywhere.` : "Choose a project to see what I keep for it."}
        </p>
        {props.projects.length > 0 && (
          <div className="field-row memory-picker">
            <label htmlFor={pickerId}>Project</label>
            <select id={pickerId} value={props.projectId ?? ""} onChange={(e) => props.onSelectProject(e.target.value)}>
              {props.projectId === undefined && <option value="">Choose a project</option>}
              {props.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </header>

      <div className="memory-grid">
        <section className="block" aria-labelledby="facts-h">
          <h2 id="facts-h" className="block-title">
            Remembered <span className="count num">{props.facts.length}</span>
          </h2>
          {props.state ? (
            <StateNote state={props.state} />
          ) : props.facts.length === 0 ? (
            <StateNote state={{ kind: "empty", detail: "Nothing remembered for this project yet." }} />
          ) : (
            <ul className="facts" aria-labelledby="facts-h">
              {groups.map((g) => (
                <li key={g.title} className="fact-group">
                  <h3 className="group-title">{g.title}</h3>
                  <ul className="facts">
                    {g.facts.map((fact) => (
                      <FactRow key={fact.id} fact={fact} sources={fact.evidenceIds.map((id) => byId.get(id))} onCorrect={props.onCorrect} onForget={forget} />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          {forgotten.length > 0 && (
            <div className="forgotten" role="group" aria-label="Forgotten just now">
              <h3 className="group-title">Forgotten just now</h3>
              <ul className="plain">
                {forgotten.map(({ fact, busy, lifted, error }) => (
                  <li key={fact.id}>
                    <span>{humanKey(fact.key)}</span>
                    {lifted ? (
                      <span className="quiet"> · may be learned again from your sources</span>
                    ) : (
                      <button type="button" className="text-button inline" disabled={busy} aria-label={`Allow relearning ${humanKey(fact.key)}`} onClick={() => void relearn(fact)}>
                        Allow relearning
                      </button>
                    )}
                    {error && <StateNote state={{ kind: "needs-retry", detail: error }} />}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="quiet small">Forgetting stops me using it and blocks relearning it from the same sources. Your original sources are never changed.</p>
        </section>

        <section className="block" aria-labelledby="withheld-h">
          <h2 id="withheld-h" className="block-title">
            Held back for you to review <span className="count num">{props.withheld.length}</span>
          </h2>
          <p className="quiet">These look like something you asked me to forget, so I am not using them.</p>
          {props.withheld.length === 0 ? (
            <StateNote state={{ kind: "empty", detail: "Nothing held back." }} />
          ) : (
            <ul className="withheld">
              {props.withheld.map((w) => (
                <WithheldRow key={w.id} item={w} onAccept={props.onAccept} onDismiss={props.onDismiss} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function FactRow({ fact, sources, onCorrect, onForget }: { fact: Fact; sources: (Evidence | undefined)[] } & Pick<MemoryViewProps, "onCorrect" | "onForget">) {
  const fieldId = useId();
  const [mode, setMode] = useState<"view" | "correct" | "forget">("view");
  const [value, setValue] = useState(fact.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMode("view");
    } catch (err) {
      setError(reason(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="fact">
      <div className="fact-head">
        <span className="fact-key">{humanKey(fact.key)}</span>
      </div>
      {mode === "correct" ? (
        <form
          className="inline-field"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => onCorrect(fact, value));
          }}
        >
          <label htmlFor={fieldId} className="sr-only">
            Correct {humanKey(fact.key)}
          </label>
          <input id={fieldId} value={value} maxLength={500} onChange={(e) => setValue(e.target.value)} autoFocus />
          <button type="submit" className="secondary" disabled={busy || value.trim() === ""}>
            Save
          </button>
          <button type="button" className="text-button" onClick={() => setMode("view")}>
            Cancel
          </button>
        </form>
      ) : (
        <p className="fact-value">{fact.value}</p>
      )}
      {sources.length === 0 ? (
        <p className="quiet small">You told me this.</p>
      ) : (
        sources.map((s, i) => (
          <p key={i} className="quiet small provenance">
            {s ? (
              <>
                From <UrlChip url={s.sourceUrl} /> “{s.text.length > 70 ? `${s.text.slice(0, 70)}…` : s.text}”, {formatWhen(s.occurredAt)}
                {s.freshness !== "current" && <StateTag state={{ kind: "stale" }} />}
              </>
            ) : (
              "From a source item that is no longer current"
            )}
          </p>
        ))
      )}
      {mode === "forget" ? (
        <div className="confirm" role="group" aria-label={`Forget ${humanKey(fact.key)}?`}>
          <p>Forget this? I will not relearn it unless you allow it.</p>
          <button type="button" className="secondary" disabled={busy} onClick={() => act(() => onForget(fact))} autoFocus>
            Forget it
          </button>
          <button type="button" className="text-button" onClick={() => setMode("view")}>
            Keep it
          </button>
        </div>
      ) : (
        mode === "view" && (
          <div className="row-actions">
            <button type="button" className="text-button" onClick={() => setMode("correct")} aria-label={`Correct ${humanKey(fact.key)}`}>
              Correct
            </button>
            <button type="button" className="text-button" onClick={() => setMode("forget")} aria-label={`Forget ${humanKey(fact.key)}`}>
              Forget
            </button>
          </div>
        )
      )}
      {error && <StateNote state={{ kind: "needs-retry", detail: error }} />}
    </li>
  );
}

function WithheldRow({ item, onAccept, onDismiss }: { item: Withheld } & Pick<MemoryViewProps, "onAccept" | "onDismiss">) {
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const act = async (action: (item: Withheld) => Promise<void>) => {
    setState({ busy: true });
    try {
      await action(item); // the row leaves the list when the subscription updates
      setState({ busy: false });
    } catch (err) {
      setState({ busy: false, error: reason(err) });
    }
  };
  return (
    <li className="fact proposal tars-voice">
      <span className="fact-key">{humanKey(item.key)}</span>
      <p className="fact-value">{item.value}</p>
      <p className="quiet small">Using it also lifts the forget it resembles, so that may be learned again.</p>
      <div className="row-actions">
        <button type="button" className="secondary" disabled={state.busy} aria-label={`Use ${humanKey(item.key)}`} onClick={() => act(onAccept)}>
          Use this
        </button>
        <button type="button" className="text-button" disabled={state.busy} aria-label={`Dismiss ${humanKey(item.key)}`} onClick={() => act(onDismiss)}>
          Dismiss
        </button>
      </div>
      {state.error && <StateNote state={{ kind: "needs-retry", detail: state.error }} />}
    </li>
  );
}
