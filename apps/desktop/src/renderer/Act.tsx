// Acting on the run-through: one clear instruction bound to the saved revision and its exact text,
// with the destination named on the button before the click. The click is the approval; there is
// no second confirmation. Receipts read honestly: an unknown outcome offers Check again, never a
// resend, and the outcome log is retried on its own. Presentational: data and actions arrive as props.
import { useId, useMemo, useState } from "react";
import type { Receipt } from "./model";
import { formatWhen, reason, StateNote } from "./ui";

export type ActKind = "send-mail" | "update-note";
export type ActIntent = { kind: ActKind; destination: string; taskId?: string; instructionId: string };
export type ActResult = { status: "receipt"; receipt: Receipt } | { status: "needs-clarification"; reason: string } | { status: "missing-send-permission" };

export type ActingActions = {
  /** Binds the intent to this exact saved revision and text. */
  execute(intent: ActIntent, saved: { artifactId: string; revision: string; text: string }): Promise<ActResult>;
  /** Looks the outcome up with the provider. Never sends again. */
  reconcile(actionId: string): Promise<void>;
  /** Writes the outcome log again. Never repeats the action. */
  retryLog(actionId: string): Promise<void>;
  setLogDestination(kind: "notion" | "obsidian", target: string): Promise<void>;
  /** Notes folders on this Mac; the log note is picked in the OS dialog, never typed or invented. */
  notes: { sources: { id: string; name: string; cloudProcessing: boolean }[]; designate(sourceId: string): Promise<{ target: string; name: string } | null> };
  /** The separate send consent, one per connected mailbox; or why none can be asked for. */
  sendConsent: { blocked: string } | { mailboxes: { name: string; start(): Promise<void> }[] };
};

export type ActProps = {
  saved: { artifactId: string; revision: string; text: string };
  /** Unsaved edits in the editor: only the saved revision can be sent. */
  dirty: boolean;
  tasks: { id: string; text: string }[];
  /** The project's newest receipt; null when nothing was done yet. */
  receipt: Receipt | null;
  /** An instruction was carried out from this screen just now (the receipt says what and where). */
  onActed(): void;
  actions: ActingActions;
  /** The project's chosen outcome log: undefined while loading, null when none is chosen. */
  logDestination: LogDestinationView | null | undefined;
};

export type LogDestinationView = { kind: "notion" | "obsidian"; label?: string };

const KIND_WORD: Record<ActKind, string> = { "send-mail": "Email", "update-note": "Notion page update" };

const verb = (kind: ActKind) => (kind === "send-mail" ? "sent" : "updated");

export function Act({ saved, dirty, tasks, receipt, onActed, actions, logDestination }: ActProps) {
  const destId = useId();
  const taskField = useId();
  const [kind, setKind] = useState<ActKind>("send-mail");
  const [destination, setDestination] = useState("");
  const [taskId, setTaskId] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [question, setQuestion] = useState<string | null>(null);
  const [needsConsent, setNeedsConsent] = useState(false);
  const [consentOpened, setConsentOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dest = destination.trim();
  // One instruction id per distinct instruction: a repeated click on the same one cannot act twice.
  const instruction = [kind, dest, saved.revision, taskId, attempt].join("|");
  const instructionId = useMemo(() => (void instruction, crypto.randomUUID()), [instruction]);
  const inFlight = receipt?.state === "pending" || receipt?.state === "running" || busy === "execute";
  // An unconfirmed outcome is checked, never resent: sending again could deliver it twice.
  const unresolved = receipt?.state === "unknown";
  const label = kind === "send-mail" ? `Send revision ${saved.revision} to ${dest || "…"}` : `Update page ${dest || "…"} with revision ${saved.revision}`;

  async function run(name: string, action: () => Promise<void>) {
    setBusy(name);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(reason(err));
    } finally {
      setBusy(null);
    }
  }

  const execute = () =>
    run("execute", async () => {
      setQuestion(null);
      setNeedsConsent(false);
      const result = await actions.execute({ kind, destination: dest, instructionId, ...(taskId ? { taskId } : {}) }, saved);
      if (result.status === "needs-clarification") setQuestion(result.reason);
      else if (result.status === "missing-send-permission") setNeedsConsent(true);
      else onActed();
    });

  return (
    <section className="act" aria-labelledby="act-h">
      <h3 id="act-h" className="group-title">
        Send or update
      </h3>
      <div className="act-steps">
        <fieldset className="choice">
          <legend className="act-step">What to do with it</legend>
          <label>
            <input type="radio" name="act-kind" checked={kind === "send-mail"} onChange={() => setKind("send-mail")} /> Send as an email
          </label>
          <label>
            <input type="radio" name="act-kind" checked={kind === "update-note"} onChange={() => setKind("update-note")} /> Update a Notion page
          </label>
        </fieldset>
        <div className="act-fields">
          <div className="field">
            <label htmlFor={destId}>{kind === "send-mail" ? "Recipient email address" : "Notion page ID"}</label>
            <input
              id={destId}
              value={destination}
              maxLength={320}
              autoComplete="off"
              type={kind === "send-mail" ? "email" : "text"}
              onChange={(e) => setDestination(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={taskField}>This completes</label>
            <select id={taskField} value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              <option value="">No specific task</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.text}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="act-confirm">
          <p className="quiet small">
            {unresolved
              ? "Check the last one first. Sending again could deliver it twice."
              : dirty
                ? "Save your edits first. Only the saved revision is ever sent, never unsaved text."
                : `Revision ${saved.revision} goes exactly as saved. Your click is the approval.`}
          </p>
          <button type="button" className="secondary" disabled={dest === "" || dirty || inFlight || unresolved || busy !== null} onClick={execute}>
            {busy === "execute" ? (kind === "send-mail" ? "Sending…" : "Updating…") : label}
          </button>
        </div>
      </div>

      {question && (
        <p className="question" role="status">
          <span className="why">Question:</span> {question}
        </p>
      )}

      {needsConsent && (
        <div className="confirm consent" role="group" aria-label="Allow sending">
          <p>
            Sending is a separate permission from reading. If you allow it, TARS may send only the messages you click Send on, from the mailbox you connected,
            and nothing else. Nothing was sent.
          </p>
          {"mailboxes" in actions.sendConsent ? (
            actions.sendConsent.mailboxes.map((m) => (
              <button key={m.name} type="button" className="secondary" disabled={busy !== null} onClick={() => run("consent", async () => (await m.start(), setConsentOpened(true)))}>
                Allow sending from {m.name}…
              </button>
            ))
          ) : (
            <p className="quiet small">{actions.sendConsent.blocked}</p>
          )}
          {busy === null && consentOpened && <p className="quiet small">Finish in your browser, then click Send again.</p>}
        </div>
      )}

      {receipt && (
        <ReceiptView
          receipt={receipt}
          busy={busy}
          onCheck={() => run("check", () => actions.reconcile(receipt.id))}
          onRetryLog={() => run("log", () => actions.retryLog(receipt.id))}
          onTryAgain={() => setAttempt((n) => n + 1)}
        />
      )}
      {error && <StateNote state={{ kind: "needs-retry", detail: error }} />}

      <LogDestination onSave={actions.setLogDestination} notes={actions.notes} current={logDestination} />
    </section>
  );
}

function ReceiptView(props: { receipt: Receipt; busy: string | null; onCheck(): void; onRetryLog(): void; onTryAgain(): void }) {
  const { receipt } = props;
  const { kind, destination } = receipt;
  const where = `${kind === "send-mail" ? " to" : ""} ${destination}`;
  const done = kind === "send-mail" ? "Sent" : "Updated";
  return (
    <div className="receipt" role="status" aria-label="What happened">
      <p className="receipt-title">What happened</p>
      <dl className="receipt-facts">
        <div>
          <dt>What</dt>
          <dd>{KIND_WORD[kind]}</dd>
        </div>
        <div>
          <dt>Where</dt>
          <dd>{destination}</dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd className="num">{receipt.revision}</dd>
        </div>
      </dl>
      {(receipt.state === "pending" || receipt.state === "running") && (
        <StateNote state={{ kind: "loading", detail: `${kind === "update-note" ? "Updating" : "Sending"}${where}. Waiting for the provider to confirm it.` }} />
      )}
      {receipt.state === "succeeded" && (
        <>
          <StateNote
            state={{
              kind: "done",
              detail: `${done}${where}, verified ${receipt.verifiedAt ? formatWhen(receipt.verifiedAt) : ""}: ${
                kind === "send-mail" ? "found in your sent mail with the same recipient and text" : "read back from the page"
              }.`,
            }}
          />
          {receipt.externalId && <p className="quiet small">Provider reference {receipt.externalId}</p>}
          <LogState receipt={receipt} busy={props.busy} onRetryLog={props.onRetryLog} />
        </>
      )}
      {receipt.state === "failed" && (
        <StateNote state={{ kind: "needs-retry", detail: `Not ${verb(kind)}${receipt.reason ? ` (${receipt.reason})` : ""}. Your draft is kept.` }}>
          <button type="button" className="text-button" onClick={props.onTryAgain}>
            Try again
          </button>
        </StateNote>
      )}
      {receipt.state === "unknown" && (
        <StateNote
          state={{
            kind: "unknown",
            detail: kind === "update-note" ? "We could not confirm this page was updated. Nothing has been repeated." : "We could not confirm this was sent. Nothing has been resent.",
          }}
        >
          <button type="button" className="text-button" disabled={props.busy !== null} onClick={props.onCheck}>
            {props.busy === "check" ? "Checking…" : "Check again"}
          </button>
        </StateNote>
      )}
    </div>
  );
}

function LogState({ receipt, busy, onRetryLog }: { receipt: Receipt; busy: string | null; onRetryLog(): void }) {
  if (receipt.logState === "not-due") return <p className="quiet small">Outcome log: no log destination chosen for this project.</p>;
  if (receipt.logState === "pending") return <StateNote state={{ kind: "loading", detail: "Outcome log pending." }} />;
  if (receipt.logState === "written") return <StateNote state={{ kind: "done", detail: "Outcome logged." }} />;
  return (
    <StateNote state={{ kind: "needs-retry", detail: "Outcome log not written. Retrying writes only the log; nothing is sent again." }}>
      <button type="button" className="text-button" disabled={busy !== null} onClick={onRetryLog}>
        {busy === "log" ? "Retrying…" : "Retry log"}
      </button>
    </StateNote>
  );
}

/** The user names the log: a Notion page they made writable, or a note they pick in one of their notes folders. Never invented. */
function LogDestination({ onSave, notes, current }: { onSave(kind: "notion" | "obsidian", target: string): Promise<void>; notes: ActingActions["notes"]; current: LogDestinationView | null | undefined }) {
  const kindId = useId();
  const targetId = useId();
  const folderId = useId();
  const [kind, setKind] = useState<"notion" | "obsidian">("notion");
  const [target, setTarget] = useState("");
  const [folder, setFolder] = useState(notes.sources[0]?.id ?? "");
  const [state, setState] = useState<{ busy: boolean; saved?: string; error?: string }>({ busy: false });
  const chosen = notes.sources.find((n) => n.id === folder) ?? notes.sources[0];

  async function save(pick: () => Promise<{ target: string; label: string } | null>) {
    setState({ busy: true });
    try {
      const picked = await pick();
      if (picked === null) return setState({ busy: false }); // the user closed the dialog
      await onSave(kind, picked.target);
      setState({ busy: false, saved: picked.label });
    } catch (err) {
      setState({ busy: false, error: reason(err) });
    }
  }

  return (
    <details className="log-destination">
      <summary>
        Where outcomes are logged{" "}
        <span className="quiet">
          ·{" "}
          {current === undefined
            ? "reading…"
            : current === null
              ? "not chosen yet"
              : current.kind === "notion"
                ? `Notion page ${current.label ?? ""}`
                : "a note in your notes folder"}
        </span>
      </summary>
      <p className="quiet small">You choose it. TARS never picks a log for you.</p>
      <div className="act-fields">
        <div className="field">
          <label htmlFor={kindId}>Log in</label>
          <select id={kindId} value={kind} onChange={(e) => setKind(e.target.value as "notion" | "obsidian")}>
            <option value="notion">A Notion page</option>
            <option value="obsidian">A note in your notes folder</option>
          </select>
        </div>
        {kind === "notion" ? (
          <form
            className="field"
            onSubmit={(e) => {
              e.preventDefault();
              void save(async () => ({ target: target.trim(), label: target.trim() }));
            }}
          >
            <label htmlFor={targetId}>Notion page ID (one you made writable in Connections)</label>
            <div className="inline-field">
              <input id={targetId} value={target} maxLength={100} onChange={(e) => setTarget(e.target.value)} />
              <button type="submit" className="secondary" disabled={state.busy || target.trim() === ""}>
                Use this page
              </button>
            </div>
          </form>
        ) : notes.sources.length === 0 ? (
          <p className="quiet small">Add a notes folder in Connections first.</p>
        ) : (
          <div className="field">
            <label htmlFor={folderId}>Notes folder</label>
            <div className="inline-field">
              <select id={folderId} value={chosen?.id ?? ""} onChange={(e) => setFolder(e.target.value)}>
                {notes.sources.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="secondary"
                disabled={state.busy || !chosen?.cloudProcessing}
                onClick={() =>
                  void save(async () => {
                    const picked = await notes.designate(chosen!.id);
                    return picked && { target: picked.target, label: picked.name };
                  })
                }
              >
                Choose note…
              </button>
            </div>
            {chosen && !chosen.cloudProcessing && (
              <p className="quiet small">Logging to a note needs cloud processing on for this notes folder. Turn it on in Connections first.</p>
            )}
          </div>
        )}
      </div>
      {state.saved && <StateNote state={{ kind: "done", detail: `Outcomes will be logged to ${state.saved}.` }} />}
      {state.error && <StateNote state={{ kind: "needs-retry", detail: state.error }} />}
    </details>
  );
}
