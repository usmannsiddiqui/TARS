// Deliberately minimal, accessible capture screen. The real UI arrives in a later task.
import { useConvex, useConvexConnectionState, useQuery } from "convex/react";
import { Component, useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import type { CaptureInput } from "@companion/domain";
import { api } from "../../../../convex/_generated/api";

type Status =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "saved"; summary: string }
  | { kind: "error"; message: string };

// Electron prefixes rejected invoke() errors; show only the main process's own message.
const reason = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (\w+: )?/, "") : String(err);

/** A failing cloud query shows as an error here instead of blanking the capture screen. */
class CloudBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  override render() {
    return this.state.error ? <p role="alert">Could not load cloud projects: {this.state.error}</p> : this.props.children;
  }
}

/** The signed-in owner's projects, live from Convex. Every state is said plainly; old data is never shown as current. */
function CloudProjects() {
  const convex = useConvex();
  const connection = useConvexConnectionState();
  const [cloudAuth, setCloudAuth] = useState<"checking" | "accepted" | "rejected">("checking");

  useEffect(() => {
    convex.setAuth(
      ({ forceRefreshToken }) => window.companion.idToken(forceRefreshToken),
      (accepted) => setCloudAuth(accepted ? "accepted" : "rejected"),
    );
    return () => convex.clearAuth();
  }, [convex]);

  const projects = useQuery(api.projects.listProjects, cloudAuth === "accepted" ? {} : "skip");

  let body: ReactNode;
  if (!connection.isWebSocketConnected) {
    body = connection.hasEverConnected
      ? "Cloud unreachable. Captures still save on this Mac; projects reappear when the connection returns."
      : "Connecting to the cloud…";
  } else if (cloudAuth === "checking") body = "Checking your sign-in with the cloud…";
  else if (cloudAuth === "rejected") body = "The cloud did not accept this sign-in. Sign in again to see your projects.";
  else if (projects === undefined) body = "Loading projects…";
  else if (projects.length === 0) body = "No projects yet.";
  else
    body = (
      <ul aria-label="Projects">
        {projects.map((project) => (
          <li key={project.id}>{project.name}</li>
        ))}
      </ul>
    );

  return (
    <section aria-labelledby="cloud-projects">
      <h2 id="cloud-projects">Projects</h2>
      {typeof body === "string" ? <p aria-live="polite">{body}</p> : body}
    </section>
  );
}

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
          <CloudBoundary>
            <CloudProjects />
          </CloudBoundary>
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
