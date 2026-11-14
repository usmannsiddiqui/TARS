// "What I remember": facts with their sources, correct, forget, and items withheld for review.
// Presentational: data and actions arrive as props.
import { useId, useState } from "react";
import type { Evidence, Fact, Honest, Withheld } from "./model";
import { formatWhen, reason, StateNote } from "./ui";

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
  onAllowRelearning(key: string): Promise<void>;
};

const humanKey = (key: string) => key.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function MemoryView(props: MemoryViewProps) {
  const pickerId = useId();
  const byId = new Map(props.evidence.map((e) => [e.id, e]));
  const projectName = props.projects.find((p) => p.id === props.projectId)?.name;

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>What I remember</h1>
        <p className="screen-sub">
          {projectName ? `In ${projectName}, plus anything you asked me to remember everywhere.` : "Choose a project to see what I keep for it."}
        </p>
      </header>

      {props.projects.length > 0 && (
        <div className="field-row">
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

      <div className="memory-grid">
        <section className="block" aria-labelledby="facts-h">
          <h2 id="facts-h" className="block-title">
            Remembered
          </h2>
          {props.state ? (
            <StateNote state={props.state} />
          ) : props.facts.length === 0 ? (
            <StateNote state={{ kind: "empty", detail: "Nothing remembered for this project yet." }} />
          ) : (
            <ul className="facts" aria-labelledby="facts-h">
              {props.facts.map((fact) => (
                <FactRow key={fact.id} fact={fact} sources={fact.evidenceIds.map((id) => byId.get(id))} {...props} />
              ))}
            </ul>
          )}
          <p className="quiet small">Forgetting stops me using it and blocks relearning it from the same sources. Your original sources are never changed.</p>
        </section>

        <section className="block" aria-labelledby="withheld-h">
          <h2 id="withheld-h" className="block-title">
            Held back for you to review
          </h2>
          <p className="quiet">These look like something you asked me to forget, so I am not using them.</p>
          {props.withheld.length === 0 ? (
            <StateNote state={{ kind: "empty", detail: "Nothing held back." }} />
          ) : (
            <ul className="facts">
              {props.withheld.map((w) => (
                <WithheldRow key={w.id} item={w} onAllow={props.onAllowRelearning} />
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
        {fact.scope === "global" && <span className="quiet"> · everywhere</span>}
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
      <p className="quiet small">
        {sources.length === 0
          ? "You told me this."
          : sources.map((s, i) => (
              <span key={i}>
                {i > 0 && " · "}
                {s ? `From “${s.text.length > 70 ? `${s.text.slice(0, 70)}…` : s.text}”, ${formatWhen(s.occurredAt)}` : "From a source item that is no longer current"}
              </span>
            ))}
      </p>
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

function WithheldRow({ item, onAllow }: { item: Withheld; onAllow(key: string): Promise<void> }) {
  const [state, setState] = useState<{ busy: boolean; done?: boolean; error?: string }>({ busy: false });
  return (
    <li className="fact">
      <span className="fact-key">{humanKey(item.key)}</span>
      <p className="fact-value">{item.value}</p>
      {state.done ? (
        <p className="quiet small">Allowed. I may learn it again the next time I prepare this project.</p>
      ) : (
        <button
          type="button"
          className="text-button"
          disabled={state.busy}
          aria-label={`Allow relearning ${humanKey(item.key)}`}
          onClick={async () => {
            setState({ busy: true });
            try {
              await onAllow(item.key);
              setState({ busy: false, done: true });
            } catch (err) {
              setState({ busy: false, error: reason(err) });
            }
          }}
        >
          Allow relearning
        </button>
      )}
      {state.error && <StateNote state={{ kind: "needs-retry", detail: state.error }} />}
    </li>
  );
}
