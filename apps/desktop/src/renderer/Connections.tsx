// Connections, added progressively. Every source starts off; turning cloud processing on shows
// the consent wording first. Presentational: rows and actions arrive as props.
import { useId, useState } from "react";
import type { SourceRow } from "./model";
import { reason, StateNote } from "./ui";

export type LocalKind = "obsidian" | "claude-code" | "codex";

export type ConnectionsProps = {
  rows: SourceRow[];
  projects: { id: string; name: string }[];
  /** Why local sources cannot be added right now (signed out, no projects yet). */
  addBlocked?: string;
  onAdd(kind: LocalKind, projectId: string): Promise<void>;
  onPause(id: string): Promise<void>;
  onResume(id: string): Promise<void>;
  onRevoke(id: string): Promise<void>;
  onSetCloud(id: string, enabled: boolean): Promise<void>;
};

/** The approved runtime-consent wording (validation/access-and-readiness.md). */
export const consentText = (source: string) =>
  `Only the items you select from ${source} are read. Excerpts are sent to our cloud and to OpenAI to prepare your work, and are stored until you delete them. Disconnecting stops new reads; it does not erase stored excerpts — use Delete for that.`;

const GROUPS: { group: SourceRow["group"]; title: string; note: string }[] = [
  { group: "mac", title: "On this Mac", note: "Read on this Mac. Nothing leaves it until you turn on cloud processing for that source." },
  { group: "cloud", title: "Cloud accounts", note: "Read through each provider's own events, only from the items you select." },
  { group: "optional", title: "Optional", note: "Off unless you choose them." },
];

export function Connections(props: ConnectionsProps) {
  const anyOn = props.rows.some((r) => r.state === "on" || r.state === "paused");
  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Connections</h1>
        <p className="screen-sub">
          {anyOn ? "Add more only when they would help." : "All off. You can capture ideas and plan without any of them."}
        </p>
      </header>
      <div className="connections">
        {GROUPS.map(({ group, title, note }) => {
          const rows = props.rows.filter((r) => r.group === group);
          if (rows.length === 0) return null;
          return (
            <section key={group} className="block" aria-labelledby={`group-${group}`}>
              <h2 id={`group-${group}`} className="block-title">
                {title}
              </h2>
              <p className="quiet">{note}</p>
              <ul className="source-rows" aria-labelledby={`group-${group}`}>
                {rows.map((row) => (
                  <SourceItem key={row.id} row={row} {...props} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

const stateWord = (row: SourceRow) => ({ off: "Off", on: "On", paused: "Paused", unavailable: "Off" })[row.state];

function SourceItem({ row, projects, addBlocked, onAdd, onPause, onResume, onRevoke, onSetCloud }: { row: SourceRow } & ConnectionsProps) {
  const projectField = useId();
  const [step, setStep] = useState<"idle" | "choose" | "consent" | "revoke">("idle");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const local = row.group === "mac";

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setStep("idle");
    } catch (err) {
      setError(reason(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="source" data-state={row.state}>
      <div className="source-head">
        <span className="source-name">{row.name}</span>
        <span className="source-state" data-state={row.state}>
          {stateWord(row)}
        </span>
      </div>
      <p className="quiet">{row.coverage}</p>
      {row.status && <StateNote state={row.status} />}
      {local && row.state !== "off" && (
        <p className="small">Cloud processing: {row.cloudProcessing ? "on" : "off, stays on this Mac"}</p>
      )}

      {row.state === "unavailable" && <p className="quiet small">{row.unavailableReason}</p>}

      {row.state === "off" && local && step === "idle" && (
        <>
          <button type="button" className="secondary" disabled={addBlocked !== undefined} onClick={() => setStep("choose")} aria-label={`Turn on ${row.name}`}>
            Turn on…
          </button>
          {addBlocked && <p className="quiet small">{addBlocked}</p>}
        </>
      )}

      {step === "choose" && (
        <div className="confirm" role="group" aria-label={`Turn on ${row.name}`}>
          <div className="field-row">
            <label htmlFor={projectField}>For project</label>
            <select id={projectField} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <p className="small">You pick the folder in the next step. It stays on this Mac until you turn on cloud processing.</p>
          <button type="button" className="secondary" disabled={busy || projectId === ""} onClick={() => act(() => onAdd(row.id as LocalKind, projectId))}>
            Choose folder…
          </button>
          <button type="button" className="text-button" onClick={() => setStep("idle")}>
            Cancel
          </button>
        </div>
      )}

      {local && (row.state === "on" || row.state === "paused") && step === "idle" && (
        <div className="row-actions">
          {!row.cloudProcessing ? (
            <button type="button" className="text-button" onClick={() => setStep("consent")}>
              Turn on cloud processing…
            </button>
          ) : (
            <button type="button" className="text-button" disabled={busy} onClick={() => act(() => onSetCloud(row.id, false))}>
              Keep on this Mac only
            </button>
          )}
          {row.state === "on" ? (
            <button type="button" className="text-button" disabled={busy} onClick={() => act(() => onPause(row.id))}>
              Pause
            </button>
          ) : (
            <button type="button" className="text-button" disabled={busy} onClick={() => act(() => onResume(row.id))}>
              Resume
            </button>
          )}
          <button type="button" className="text-button" onClick={() => setStep("revoke")}>
            Disconnect…
          </button>
        </div>
      )}

      {step === "consent" && (
        <div className="confirm consent" role="group" aria-label={`Cloud processing for ${row.name}`}>
          <p>{consentText(row.name)}</p>
          <button type="button" className="secondary" disabled={busy} onClick={() => act(() => onSetCloud(row.id, true))}>
            Turn on cloud processing
          </button>
          <button type="button" className="text-button" onClick={() => setStep("idle")} autoFocus>
            Keep it on this Mac
          </button>
        </div>
      )}

      {step === "revoke" && (
        <div className="confirm" role="group" aria-label={`Disconnect ${row.name}`}>
          <p>Stop reading {row.name}? New reads stop now. Excerpts already sent to the cloud stay stored.</p>
          <button type="button" className="secondary" disabled={busy} onClick={() => act(() => onRevoke(row.id))}>
            Disconnect
          </button>
          <button type="button" className="text-button" onClick={() => setStep("idle")} autoFocus>
            Keep it
          </button>
        </div>
      )}
      {error && <StateNote state={{ kind: "needs-retry", detail: error }} />}
    </li>
  );
}
