// Deliberately minimal, accessible capture screen. The real UI arrives in a later task.
import { useEffect, useId, useState, type FormEvent } from "react";
import type { CaptureInput } from "@companion/domain";

type Status =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "saved"; summary: string }
  | { kind: "error"; message: string };

// Electron prefixes rejected invoke() errors; show only the main process's own message.
const reason = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (\w+: )?/, "") : String(err);

export function App() {
  const inputId = useId();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<CaptureInput[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const fail = (err: unknown) => setStatus({ kind: "error", message: reason(err) });
  const refresh = () => window.companion.loadPending().then(setPending, fail);

  useEffect(() => {
    window.companion.authStatus().then(({ signedIn }) => {
      setSignedIn(signedIn);
      if (signedIn) void refresh();
    }, fail);
  }, []);

  async function signIn() {
    setStatus({ kind: "busy", label: "Waiting for sign-in in your browser…" });
    try {
      const result = await window.companion.signIn();
      setSignedIn(result.signedIn);
      setStatus({ kind: "idle" });
      if (result.signedIn) await refresh();
    } catch (err) {
      fail(err);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setStatus({ kind: "busy", label: "Saving…" });
    try {
      const receipt = await window.companion.saveCapture({ text, origin: "typed" });
      setStatus({ kind: "saved", summary: receipt.summary });
      setText("");
      await refresh();
    } catch (err) {
      fail(err);
    }
  }

  const busy = status.kind === "busy";

  return (
    <main>
      <h1>Companion</h1>
      {signedIn === false && (
        <section aria-label="Account">
          <p>Not signed in. Sign in to save captures on this Mac.</p>
          <button type="button" onClick={signIn} disabled={busy}>
            Sign in with browser
          </button>
        </section>
      )}
      {signedIn && (
        <>
          <form onSubmit={onSubmit}>
            <label htmlFor={inputId}>Capture an idea</label>
            <textarea id={inputId} value={text} onChange={(e) => setText(e.target.value)} required />
            <button type="submit" disabled={busy || text.trim() === ""}>
              Save
            </button>
          </form>
          <h2>Pending captures</h2>
          {pending.length === 0 ? (
            <p>No pending captures.</p>
          ) : (
            <ul aria-label="Pending captures">
              {pending.map((capture, i) => (
                <li key={i}>{capture.text}</li>
              ))}
            </ul>
          )}
        </>
      )}
      <p role="status" aria-live="polite">
        {status.kind === "busy" && status.label}
        {status.kind === "saved" && `Saved on this Mac: ${status.summary}`}
        {status.kind === "error" && `Error: ${status.message}`}
      </p>
    </main>
  );
}
