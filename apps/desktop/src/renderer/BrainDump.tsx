// The sorted brain dump under the capture box: the user's own words filed by project, each line with its
// kind (glyph and word) and due time, and a Fix disclosure to move, relabel or remove it. A summary to
// correct, never an approval gate: nothing here waits on a confirm, sends, drafts or changes focus.
// Presentational: the view arrives by subscription, actions as props.
import { useState } from "react";
import { groupSorted, type SortKind } from "../../../../packages/domain/src/sort";
import { reason, StateNote } from "./ui";

export type DumpLine = { id: string; text: string; projectId: string | null; kind: SortKind; dueAt?: string };
export type DumpView = { kind: "sorting"; projects: number } | { kind: "sorted"; lines: DumpLine[] } | { kind: "failed"; detail: string };
export type BrainDumpProps = {
  /** Signed in with the cloud reachable: Save also sends the text to be sorted. */
  cloud: boolean;
  projects: { id: string; name: string }[];
  view?: DumpView;
  /** The capture is durably on this Mac: sort it (once). */
  onSaved(captureId: string, text: string): void;
  onRetry(): void;
  onMove(id: string, projectId: string | null): Promise<void>;
  onSetKind(id: string, kind: SortKind): Promise<void>;
  onRemove(id: string): Promise<void>;
};

const KIND_WORD: Record<SortKind, string> = { todo: "To do", waiting: "Waiting on someone", parked: "Parked", idea: "Idea" };
const KINDS = Object.keys(KIND_WORD) as SortKind[];
const due = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A 14px shape per kind, so a kind reads by shape and word, never by colour. */
function KindGlyph({ kind }: { kind: SortKind }) {
  const line = { fill: "none", stroke: "currentColor", strokeWidth: 1.8 } as const;
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden="true" className="glyph">
      {kind === "todo" && <rect x="2.2" y="2.2" width="9.6" height="9.6" {...line} />}
      {kind === "waiting" && <path d="M3 1.8h8M3 12.2h8M4 2.2 10 11.8M10 2.2 4 11.8" {...line} />}
      {kind === "parked" && (
        <>
          <rect x="3" y="2.5" width="2.6" height="9" fill="currentColor" />
          <rect x="8.4" y="2.5" width="2.6" height="9" fill="currentColor" />
        </>
      )}
      {kind === "idea" && <path d="M7 1.8 12.2 7 7 12.2 1.8 7Z" {...line} />}
    </svg>
  );
}

export function SortedDump(props: BrainDumpProps & { view: DumpView }) {
  const { view } = props;
  if (view.kind === "sorting") {
    const words = `Sorting into your ${plural(view.projects, "project")}`;
    return (
      <section className="dump" aria-label="Sorting your capture" aria-busy="true">
        <p className="dump-working">
          <span className="helper-track" aria-hidden="true">
            <span className="helper-step" data-step="done" />
            <span className="helper-step" data-step="now" />
          </span>
          <span>Saved on this Mac · {words}</span>
        </p>
        <p className="sr-only" role="status">
          {words}
        </p>
      </section>
    );
  }
  if (view.kind === "failed") {
    return (
      <section className="dump" aria-label="Sorting your capture">
        <StateNote state={{ kind: "needs-retry", detail: `Saved on this Mac, not sorted yet: ${view.detail} It will be sorted when you press Sort again.` }}>
          <span className="row-actions">
            <button type="button" className="text-button" onClick={props.onRetry}>
              Sort again
            </button>
          </span>
        </StateNote>
      </section>
    );
  }
  const groups = groupSorted(view.lines, props.projects);
  const filed = groups.filter((g) => g.projectId !== null).length;
  const summary =
    view.lines.length === 0 ? "Nothing to file from that one" : `Sorted ${plural(view.lines.length, "thought")} into ${plural(filed, "project")}`;
  return (
    <section className="dump" aria-label="Your capture, sorted">
      <details className="dump-result" open>
        <summary className="dump-summary">
          <span role="status">{summary}</span>
        </summary>
        {groups.map((group) => (
          <section key={group.projectId ?? "none"} className="dump-group" aria-label={group.name}>
            <h3 className="dump-project" data-none={group.projectId === null ? "" : undefined}>
              {group.name}
            </h3>
            <ul className="dump-lines">
              {group.items.map((line) => (
                <DumpRow key={line.id} line={line} {...props} />
              ))}
            </ul>
          </section>
        ))}
      </details>
    </section>
  );
}

function DumpRow({ line, projects, onMove, onSetKind, onRemove }: BrainDumpProps & { line: DumpLine }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(reason(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="dump-line" data-kind={line.kind}>
      <p className="dump-text">{line.text}</p>
      <div className="dump-meta">
        <span className="dump-kind">
          <KindGlyph kind={line.kind} />
          {KIND_WORD[line.kind]}
        </span>
        {line.dueAt && <span className="dump-due">due {due.format(new Date(line.dueAt))}</span>}
        <FixDisclosure line={line} projects={projects} busy={busy} act={act} onMove={onMove} onSetKind={onSetKind} onRemove={onRemove} />
      </div>
      {error && <StateNote state={{ kind: "needs-retry", detail: error }} />}
    </li>
  );
}

function FixDisclosure({
  line,
  projects,
  busy,
  act,
  onMove,
  onSetKind,
  onRemove,
}: Pick<BrainDumpProps, "projects" | "onMove" | "onSetKind" | "onRemove"> & { line: DumpLine; busy: boolean; act(fn: () => Promise<void>): () => Promise<void> }) {
  return (
      <details className="dump-fix">
        <summary aria-label={`Fix “${line.text}”`}>Fix</summary>
        <div className="dump-fix-body">
          <label>
            <span>Kind</span>
            <select value={line.kind} disabled={busy} onChange={(e) => void act(() => onSetKind(line.id, e.target.value as SortKind))()}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_WORD[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Project</span>
            <select value={line.projectId ?? ""} disabled={busy} onChange={(e) => void act(() => onMove(line.id, e.target.value || null))()}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="">No project yet</option>
            </select>
          </label>
          <button type="button" className="text-button" disabled={busy} onClick={act(() => onRemove(line.id))}>
            Remove
          </button>
        </div>
      </details>
  );
}
