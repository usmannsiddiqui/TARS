// Connections, added progressively. Every source starts off. Turning cloud processing on, and
// connecting a cloud account, both show the consent wording first. Presentational: rows and actions arrive as props.
import { useId, useState, type FormEvent } from "react";
import { gmailSelectors, parseRepositories, parseSlackChannels, type ParsedSelectors } from "../../../../packages/domain/src/composio";
import { kindOfName, SourceLogo } from "./logos";
import type { CloudProvider, Honest, SourceRow } from "./model";
import { AllowSending, reason, StateNote } from "./ui";

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
  cloud: CloudActions;
  observation: ObservationActions;
  shortcut: { status: ShortcutStatus | null; onSet(accelerator: string): Promise<void> };
  /** The held talk key, shown beside the capture shortcut. */
  talkKey: { status: TalkKeyStatus | null; onOpenAccessibility(): Promise<void> };
  telegram: TelegramActions;
};

/** telegram.status as the card reads it (convex/telegram.ts). */
export type TelegramStatus = {
  bot: string | null;
  linked: boolean;
  last: { state: "waiting" | "queued" | "sent" | "failed"; at: number } | null;
};
export type TelegramActions = {
  /** Undefined while loading. */
  status: TelegramStatus | undefined;
  onLink(): Promise<string>;
  onUnlink(): Promise<void>;
  onTest(): Promise<void>;
};

export type TalkKeyStatus = { key: string; state: "starting" | "ready" | "permission-missing" | "unavailable" };

export type ShortcutStatus = { accelerator: string; registered: boolean; error?: string };

export type ObservationActions = {
  /** Selectors: app bundle ids ("com.apple.Notes") or browser sites ("com.google.Chrome|https://docs.google.com"). */
  onStart(selectors: string[], projectId: string): Promise<void>;
  onDeleteRetained(id: string): Promise<void>;
  /** Only from the user's click: opens System Settings > Accessibility; nothing is requested. */
  onOpenAccessibility(): Promise<void>;
};

/** Observation consent: what is read, what is not, and where it goes. */
export const observationConsent =
  "Only visible text from the apps and sites you name is read, while they are in front. No screenshots and no keystrokes. The text stays on this Mac until you turn on cloud processing for it. Pausing stops reading; it does not erase what was kept, which Delete kept text does.";

export type ConnectForm = { projectId: string; credential?: string; selectors: string[]; writeTargets: string[] };

export type CloudActions = {
  /** Why cloud accounts cannot be connected right now (signed out, no projects yet). */
  blocked?: string;
  /** Records the grant for exactly this selection, then connects with the credential or opens the provider's sign-in in the browser. */
  onConnect(provider: CloudProvider, form: ConnectForm): Promise<void>;
  onRefresh(row: SourceRow): Promise<void>;
  onPause(row: SourceRow): Promise<void>;
  onResume(row: SourceRow): Promise<void>;
  onRevoke(row: SourceRow): Promise<void>;
  /** The separate permission to send from this connected account (Composio Gmail); it sends nothing. */
  onAllowSend(row: SourceRow): Promise<void>;
  notionWebhookUrl(sourceId: string): string;
  revealNotionToken(sourceId: string): Promise<string>;
};

// Composio-connected cards (Slack, Gmail, Outlook mail, Teams) update only by push; nothing to refresh by hand.
const REFRESHABLE: CloudProvider[] = ["canvas", "outlook-calendar"];

/** The approved runtime-consent wording (validation/access-and-readiness.md). */
export const consentText = (source: string) =>
  `Only the items you select from ${source} are read. Excerpts are sent to our cloud and to OpenAI to prepare your work, and are kept in our cloud. Disconnecting stops new reads; excerpts already stored stay stored.`;

const GROUPS: { group: SourceRow["group"]; title: string; note: string }[] = [
  { group: "mac", title: "On this Mac", note: "Read on this Mac. Nothing leaves it until you turn on cloud processing for that source." },
  { group: "cloud", title: "Cloud accounts", note: "Read through each provider's own events, only from the items you select." },
  { group: "optional", title: "Optional", note: "Off unless you choose them." },
];

export function Connections(props: ConnectionsProps) {
  const anyOn = props.rows.some((r) => r.state === "on" || r.state === "paused");
  const count = (test: (r: SourceRow) => boolean) => String(props.rows.filter(test).length);
  const attention = (r: SourceRow) => r.permissionMissing === true || (r.status !== undefined && ["needs-retry", "missing-access", "stale", "not-signed-in"].includes(r.status.kind));
  const readout: [string, string][] = [
    ["On", count((r) => r.state === "on")],
    ["Paused", count((r) => r.state === "paused")],
    ["Off", count((r) => r.state === "off" || r.state === "unavailable")],
    ["Need a look", count(attention)],
  ];
  return (
    <div className="screen connections-screen">
      <header className="screen-head">
        <h1>Connections</h1>
        <p className="screen-sub">
          {anyOn ? "Add more only when they would help." : "All off. You can capture ideas and plan without any of them."}
        </p>
        <ul className="readout" aria-label="Sources now">
          {readout.map(([key, value]) => (
            <li key={key}>
              <span className="readout-key">{key}</span> {value}
            </li>
          ))}
        </ul>
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
        <ShortcutSetting {...props.shortcut} talkKey={props.talkKey} />
        <TelegramCard {...props.telegram} />
      </div>
    </div>
  );
}

function ShortcutSetting({ status, onSet, talkKey }: ConnectionsProps["shortcut"] & { talkKey: ConnectionsProps["talkKey"] }) {
  const id = useId();
  const [value, setValue] = useState("");
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });
  return (
    <section className="block" aria-labelledby="shortcut-h">
      <h2 id="shortcut-h" className="block-title">
        Capture shortcut
      </h2>
      {status === null ? (
        <StateNote state={{ kind: "loading" }} />
      ) : status.registered ? (
        <StateNote state={{ kind: "done", detail: `${status.accelerator} opens capture. It never starts recording.` }} />
      ) : (
        <StateNote state={{ kind: "needs-retry", detail: `${status.accelerator} is not working: ${status.error ?? "another app already uses it"}. Choose another.` }} />
      )}
      <form
        className="inline-field shortcut-field"
        onSubmit={async (e) => {
          e.preventDefault();
          setState({ busy: true });
          try {
            await onSet(value.trim());
            setState({ busy: false });
          } catch (err) {
            setState({ busy: false, error: reason(err) });
          }
        }}
      >
        <label htmlFor={id} className="sr-only">
          New shortcut
        </label>
        <input id={id} value={value} placeholder="For example CommandOrControl+Shift+K" maxLength={64} onChange={(e) => setValue(e.target.value)} />
        <button type="submit" className="secondary" disabled={state.busy || value.trim() === ""}>
          Use this shortcut
        </button>
      </form>
      {state.error && <StateNote state={{ kind: "needs-retry", detail: state.error }} />}
      <h3 className="block-title">Hold to talk</h3>
      <TalkKeyNote {...talkKey} />
    </section>
  );
}

/** Which key to hold, and whether macOS lets it work; the voice button under TARS works either way. */
function TalkKeyNote({ status, onOpenAccessibility }: ConnectionsProps["talkKey"]) {
  if (!status || status.state === "starting") return <StateNote state={{ kind: "loading" }} />;
  if (status.state === "ready") {
    return <StateNote state={{ kind: "done", detail: `Hold ${status.key} anywhere to talk; let go and the words land in the capture box to edit. Nothing is saved until you press Save.` }} />;
  }
  if (status.state === "unavailable") {
    return <StateNote state={{ kind: "needs-retry", detail: `Holding ${status.key} is unavailable: its helper is not running. Restart TARS; the voice button under TARS still works.` }} />;
  }
  return (
    <StateNote state={{ kind: "missing-access", detail: `Holding ${status.key} to talk needs macOS Accessibility access for TARS. It reports only that key going down and up. The voice button under TARS works without it.` }}>
      <button type="button" className="text-button" onClick={() => void onOpenAccessibility()}>
        Open Accessibility settings
      </button>
    </StateNote>
  );
}

/** The last message to the phone in words: "sent" only when Telegram accepted it. */
function lastNote(status: TelegramStatus): Honest | null {
  if (status.last?.state === "sent") return { kind: "done", detail: "Last message: sent to your phone." };
  if (status.last?.state === "failed") return { kind: "needs-retry", detail: "Last message: Telegram did not send it." };
  return null;
}

/** His one Telegram chat: linked by a code he sends to the bot; that chat alone can instruct TARS by message. */
function TelegramCard({ status, onLink, onUnlink, onTest }: TelegramActions) {
  const [code, setCode] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const linked = status?.linked === true;
  const row: SourceRow = { id: "telegram", name: "TARS on Telegram", coverage: "Message TARS from your phone; nudges and your stop recap come there too", group: "mac", state: linked ? "on" : "off" };

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(reason(err));
    } finally {
      setBusy(false);
    }
  }
  const note = status && linked ? lastNote(status) : null;

  return (
    <section className="block" aria-labelledby="telegram-h">
      <h2 id="telegram-h" className="block-title">
        TARS on Telegram
      </h2>
      <ul className="source-rows" aria-labelledby="telegram-h">
        <li className="source" data-state={row.state}>
          <CardHead
            row={row}
            by="through a Telegram bot · only your linked chat can instruct TARS"
            add={!linked && status?.bot ? { label: "Link my phone", disabled: busy, onClick: () => void act(async () => setCode(await onLink())) } : undefined}
          />
          {status === undefined && <StateNote state={{ kind: "loading" }} />}
          {status && status.bot === null && <StateNote state={{ kind: "missing-access", detail: "Telegram is not set up on this TARS backend yet." }} />}
          {status && !linked && code && (
            <p role="status">
              In Telegram, send <strong>{code}</strong> to @{status.bot}. The code works once, for 10 minutes. Nothing is sent to your phone until it is linked.
            </p>
          )}
          {linked && (
            <>
              <p className="small">Linked to your Telegram. Sending anything still needs your exact SEND.</p>
              {note && <StateNote state={note} />}
              <button type="button" className="secondary" disabled={busy} onClick={() => void act(onTest)}>
                Send me a test message
              </button>
              <button type="button" className="text-button" disabled={busy} onClick={() => void act(async () => (setCode(undefined), await onUnlink()))}>
                Unlink
              </button>
            </>
          )}
          {error && <StateNote state={{ kind: "needs-retry", detail: error }} />}
        </li>
      </ul>
    </section>
  );
}

const stateWord = (row: SourceRow) => ({ off: "Off", on: "On", paused: "Paused", unavailable: "Off" })[row.state];

/** Who runs the service, as the connector card says it. */
const BY: Record<CloudProvider, string> = {
  slack: "by Slack, sign-in held by Composio",
  gmail: "by Google, sign-in held by Composio",
  notion: "by Notion",
  canvas: "by Instructure",
  "outlook-mail": "by Microsoft, sign-in held by Composio",
  "outlook-calendar": "by Microsoft",
  teams: "by Microsoft, sign-in held by Composio",
  github: "by GitHub, sign-in held by Composio",
};
/** What TARS may do with it, from what the connect flow asks for: only Notion takes write targets, and sending is its own consent. */
const CAN: Partial<Record<CloudProvider, string>> = { notion: "reads, and updates only pages you allow", gmail: "reads; sends only if you allow it", slack: "reads; posts only if you allow it" };

// Local rows carry no kind, but their names start with the kind's display name ("Notes folder: HackUmass vault").
const kindOf = (row: SourceRow) => row.provider ?? (row.group === "optional" ? "observation" : kindOfName(row.name.split(": ")[0] ?? ""));

/**
 * A connector card's head: the logo tile, the name with its state plate, one line on what it reads, who runs
 * it, and on the right the status square: `add` (the plus that starts connecting), or a check when connected.
 */
function CardHead({ row, add, by }: { row: SourceRow; add?: { label: string; disabled: boolean; onClick(): void } | undefined; by?: string }) {
  const connected = row.state === "on" || row.state === "paused";
  return (
    <div className="connector-head">
      <span className="logo-tile">
        <SourceLogo kind={kindOf(row) ?? ""} size={24} />
      </span>
      <div className="connector-id">
        <p className="connector-title">
          <span className="source-name">{row.name}</span>
          <span className="source-state" data-state={row.state}>
            {stateWord(row)}
          </span>
        </p>
        <p className="quiet connector-desc">{row.coverage}</p>
        <p className="quiet small">
          {by ?? `${row.provider ? BY[row.provider] : "on this Mac"} · ${(row.provider && CAN[row.provider]) ?? "read only"}`}
        </p>
      </div>
      {add ? (
        <button type="button" className="secondary connector-square" disabled={add.disabled} onClick={add.onClick} aria-label={add.label}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 2.5v11M2.5 8h11" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>
      ) : (
        connected && (
          <span className="connector-square connector-check" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 16 16">
              <path d="m3 8.5 3.2 3.2L13 4.5" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </span>
        )
      )}
    </div>
  );
}

function SourceItem(props: { row: SourceRow } & ConnectionsProps) {
  if (props.row.provider) return <CloudItem {...props} provider={props.row.provider} />;
  if (props.row.group === "optional" && props.row.state === "off") return <ObservationStart {...props} />;
  return <LocalItem {...props} />;
}

function LocalItem({ row, projects, addBlocked, onAdd, onPause, onResume, onRevoke, onSetCloud, observation }: { row: SourceRow } & ConnectionsProps) {
  const projectField = useId();
  const [step, setStep] = useState<"idle" | "choose" | "consent" | "revoke" | "delete">("idle");
  const observed = row.group === "optional";
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const local = row.group === "mac" || observed;

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
      <CardHead
        row={row}
        add={row.state === "off" && local && step === "idle" ? { label: `Turn on ${row.name}`, disabled: addBlocked !== undefined, onClick: () => setStep("choose") } : undefined}
      />
      {row.status && <StateNote state={row.status} />}
      {local && row.state !== "off" && (
        <p className="small">Cloud processing: {row.cloudProcessing ? "on" : "off, stays on this Mac"}</p>
      )}

      {row.state === "unavailable" && <p className="quiet small">{row.unavailableReason}</p>}

      {row.state === "off" && local && step === "idle" && addBlocked && <p className="quiet small">{addBlocked}</p>}

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
          {observed && (
            <button type="button" className="text-button" onClick={() => setStep("delete")}>
              Delete kept text…
            </button>
          )}
        </div>
      )}

      {observed && row.permissionMissing && (
        <StateNote state={{ kind: "missing-access", detail: "macOS Accessibility permission is off for TARS, so nothing is read." }}>
          <button type="button" className="text-button" disabled={busy} onClick={() => act(observation.onOpenAccessibility)}>
            Open Accessibility settings
          </button>
        </StateNote>
      )}

      {step === "delete" && (
        <div className="confirm" role="group" aria-label={`Delete kept text from ${row.name}`}>
          <p>Delete the text kept from {row.name}? This cannot be undone. Reading continues unless you pause or disconnect.</p>
          <button type="button" className="secondary" disabled={busy} onClick={() => act(() => observation.onDeleteRetained(row.id))}>
            Delete kept text
          </button>
          <button type="button" className="text-button" onClick={() => setStep("idle")} autoFocus>
            Keep it
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

type Fields = {
  credential?: string;
  /** One line under the credential field saying where to find it. */
  credentialHelp?: string;
  /** Replaces the default line about how the token is kept. */
  credentialNote?: string;
  /** Absent: the credential itself decides what is read (Canvas's feed is the whole calendar). */
  selectors?: string;
  /** One line under the selector field saying where to find what it asks for. */
  help?: string;
  /** The selector rule; without one, any non-empty comma list is accepted. */
  parse?(text: string): ParsedSelectors;
  /** Gmail: a choice between the inbox (default) and named labels, the labels field shown only for the second. */
  inbox?: true;
  writeTargets?: string;
  /** OAuth: whose sign-in page opens. */
  signIn?: string;
};
const FIELDS: Record<CloudProvider, Fields> = {
  slack: {
    selectors: "Channel IDs to read, separated by commas",
    help: "In Slack: right-click the channel → View channel details → the Channel ID is at the bottom, starting with C.",
    parse: parseSlackChannels,
    signIn: "Composio",
  },
  notion: {
    credential: "Internal integration token",
    selectors: "Page IDs to read, separated by commas",
    writeTargets: "Page IDs TARS may write to, separated by commas (optional, for updates and the outcome log)",
  },
  canvas: {
    credential: "Canvas calendar feed link",
    credentialHelp: "In Canvas: Calendar → Calendar Feed (bottom right) → copy the link",
    credentialNote:
      "Anyone with this link can read your Canvas calendar. It is sent once to the cloud and kept sealed there, never shown again and never kept on this Mac.",
  },
  gmail: { selectors: "Label IDs to read, separated by commas", inbox: true, signIn: "Composio" },
  "outlook-mail": { selectors: "Mail folder IDs to read, separated by commas", signIn: "Composio" },
  "outlook-calendar": { selectors: "Calendar IDs to read, separated by commas", signIn: "Microsoft" },
  teams: { selectors: "Teams chat IDs, separated by commas", signIn: "Composio" },
  github: { selectors: "Repositories to read, as owner/name, separated by commas", parse: parseRepositories, signIn: "Composio" },
};
const list = (text: string) => text.split(",").map((s) => s.trim()).filter((s) => s !== "");

function CloudItem({ row, provider, projects, cloud }: { row: SourceRow; provider: CloudProvider } & ConnectionsProps) {
  const [step, setStep] = useState<"idle" | "connect" | "revoke">("idle");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const fields = FIELDS[provider];
  const blocked = cloud.blocked;

  async function act(name: string, action: () => Promise<void>) {
    setBusy(name);
    setError(null);
    try {
      await action();
      setStep("idle");
    } catch (err) {
      setError(reason(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="source" data-state={row.state}>
      <CardHead row={row} add={row.state === "off" && step === "idle" ? { label: `Connect ${row.name}`, disabled: blocked !== undefined, onClick: () => setStep("connect") } : undefined} />
      {row.status ? <StateNote state={row.status} /> : row.state === "off" && <p className="quiet small">Availability: not connected. Last checked: never.</p>}
      {row.selection && (
        <p className="small source-selection">
          <span className="why">Reads:</span> {row.selection.selectors.join(", ") || "your whole calendar feed"} <span className="quiet">· for {row.selection.projects.join(", ")}</span>
        </p>
      )}
      {row.state === "paused" && <p className="small">Paused: nothing new is read until you resume. What was read stays stored.</p>}
      {provider === "gmail" && row.sending && <AllowSending account={row.name} state={row.sending} onAllow={() => cloud.onAllowSend(row)} />}

      {row.state === "off" && step === "idle" && (
        <>
          {blocked && <p className="quiet small">{blocked}</p>}
          {row.unavailableReason && <p className="quiet small">{row.unavailableReason}</p>}
        </>
      )}

      {row.state === "off" && started && step === "idle" && (
        <p className="quiet small" role="status">
          Finish in your browser. {row.name} turns on here when {fields.signIn} confirms it.
        </p>
      )}

      {step === "connect" && (
        <CloudConnectForm
          name={row.name}
          fields={fields}
          projects={projects}
          busy={busy !== null}
          onCancel={() => setStep("idle")}
          onSubmit={(form) =>
            act("connect", async () => {
              await cloud.onConnect(provider, form);
              if (fields.signIn) setStarted(true);
            })
          }
        />
      )}

      {(row.state === "on" || row.state === "paused") && step === "idle" && (
        <>
          {provider === "notion" && row.state === "on" && <NotionWebhook sourceId={row.id} url={cloud.notionWebhookUrl(row.id)} reveal={cloud.revealNotionToken} />}
          <div className="row-actions">
            {REFRESHABLE.includes(provider) && row.state === "on" && (
              <button type="button" className="text-button" disabled={busy !== null} onClick={() => act("refresh", () => cloud.onRefresh(row))} aria-label={`Refresh ${row.name}`}>
                {busy === "refresh" ? "Refreshing…" : "Refresh"}
              </button>
            )}
            {row.state === "on" ? (
              <button type="button" className="text-button" disabled={busy !== null} onClick={() => act("pause", () => cloud.onPause(row))}>
                {busy === "pause" ? "Pausing…" : "Pause"}
              </button>
            ) : (
              <button type="button" className="text-button" disabled={busy !== null} onClick={() => act("resume", () => cloud.onResume(row))}>
                {busy === "resume" ? "Resuming…" : "Resume"}
              </button>
            )}
            <button type="button" className="text-button" onClick={() => setStep("revoke")}>
              Disconnect…
            </button>
          </div>
        </>
      )}

      {step === "revoke" && (
        <div className="confirm" role="group" aria-label={`Disconnect ${row.name}`}>
          <p>Stop reading {row.name}? New reads stop now. Excerpts already sent to the cloud stay stored.</p>
          <button type="button" className="secondary" disabled={busy !== null} onClick={() => act("revoke", () => cloud.onRevoke(row))}>
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

function CloudConnectForm(props: {
  name: string;
  fields: Fields;
  projects: { id: string; name: string }[];
  busy: boolean;
  onCancel(): void;
  onSubmit(form: ConnectForm): void;
}) {
  const ids = { project: useId(), credential: useId(), credentialHelp: useId(), selectors: useId(), write: useId(), help: useId(), error: useId() };
  const [projectId, setProjectId] = useState(props.projects[0]?.id ?? "");
  const [credential, setCredential] = useState("");
  const [selectors, setSelectors] = useState("");
  const [labels, setLabels] = useState(false);
  const [writeTargets, setWriteTargets] = useState("");
  const { fields } = props;
  const parsed: ParsedSelectors = fields.inbox
    ? gmailSelectors(labels ? "labels" : "inbox", selectors)
    : fields.selectors === undefined
      ? { selectors: [] }
      : fields.parse
        ? fields.parse(selectors)
        : list(selectors).length > 0
          ? { selectors: list(selectors) }
          : { error: "" };
  // Say what is wrong once there is something to correct (or a label choice to finish), not on an untouched field.
  const error = "error" in parsed && parsed.error !== "" && (selectors.trim() !== "" || labels) ? parsed.error : null;
  const showSelectors = fields.selectors !== undefined && (!fields.inbox || labels);
  const ready = projectId !== "" && (!props.fields.credential || credential.trim() !== "") && "selectors" in parsed;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!("selectors" in parsed) || !ready) return;
    props.onSubmit({
      projectId,
      selectors: parsed.selectors,
      writeTargets: list(writeTargets),
      ...(props.fields.credential ? { credential: credential.trim() } : {}),
    });
  };
  return (
    <form className="confirm consent connect-form" aria-label={`Connect ${props.name}`} onSubmit={submit}>
      <div className="field">
        <label htmlFor={ids.project}>For project</label>
        <select id={ids.project} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {props.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {props.fields.credential && (
        <div className="field">
          <label htmlFor={ids.credential}>{props.fields.credential}</label>
          <input
            id={ids.credential}
            type="password"
            value={credential}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={fields.credentialHelp ? ids.credentialHelp : undefined}
            onChange={(e) => setCredential(e.target.value)}
          />
          {fields.credentialHelp && (
            <p id={ids.credentialHelp} className="hint">
              {fields.credentialHelp}
            </p>
          )}
        </div>
      )}
      {fields.inbox && (
        <fieldset className="choice">
          <legend>What to read</legend>
          <label>
            <input type="radio" name={`${ids.selectors}-read`} checked={!labels} onChange={() => setLabels(false)} /> Inbox
          </label>
          <label>
            <input type="radio" name={`${ids.selectors}-read`} checked={labels} onChange={() => setLabels(true)} /> Only these labels
          </label>
        </fieldset>
      )}
      {showSelectors && (
        <div className="field">
          <label htmlFor={ids.selectors}>{fields.selectors}</label>
          <input
            id={ids.selectors}
            value={selectors}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error !== null}
            aria-describedby={[fields.help ? ids.help : "", error ? ids.error : ""].join(" ").trim() || undefined}
            onChange={(e) => setSelectors(e.target.value)}
          />
          {fields.help && (
            <p id={ids.help} className="hint">
              {fields.help}
            </p>
          )}
          {error && (
            <p id={ids.error} className="field-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
      {props.fields.writeTargets && (
        <div className="field">
          <label htmlFor={ids.write}>{props.fields.writeTargets}</label>
          <input id={ids.write} value={writeTargets} autoComplete="off" spellCheck={false} onChange={(e) => setWriteTargets(e.target.value)} />
        </div>
      )}
      <p>{consentText(props.name)}</p>
      <p className="quiet small">
        {props.fields.signIn === "Composio"
          ? `Composio's sign-in page opens in your browser. Composio holds your ${props.name} sign-in for TARS; TARS keeps only which account it is. Reading only; sending is a separate permission asked for later.`
          : props.fields.signIn
          ? `${props.fields.signIn}'s sign-in page opens in your browser. Reading only; sending is a separate permission asked for later.`
          : (props.fields.credentialNote ?? "The token is sent once to the cloud, sealed there, and never kept on this Mac.")}
      </p>
      <button type="submit" className="secondary" disabled={!ready || props.busy}>
        {props.busy ? "Connecting…" : props.fields.signIn ? `Continue to ${props.fields.signIn} sign-in` : `Connect ${props.name}`}
      </button>
      <button type="button" className="text-button" onClick={props.onCancel}>
        Cancel
      </button>
    </form>
  );
}

/** Notion delivers changes by webhook: the user adds this URL in Notion, then pastes the token Notion sends into its Verify dialog. */
function NotionWebhook({ sourceId, url, reveal }: { sourceId: string; url: string; reveal(sourceId: string): Promise<string> }) {
  const [token, setToken] = useState<{ busy: boolean; value?: string; error?: string }>({ busy: false });
  return (
    <div className="confirm webhook" role="group" aria-label="Notion updates">
      <p>
        So changes arrive without checking on a timer: in your Notion integration, add a webhook subscription with this URL. Notion then sends a verification
        token; show it here and paste it into Notion's Verify dialog.
      </p>
      <code className="copyable">{url}</code>
      <button
        type="button"
        className="text-button"
        disabled={token.busy}
        onClick={async () => {
          setToken({ busy: true });
          try {
            setToken({ busy: false, value: await reveal(sourceId) });
          } catch (err) {
            setToken({ busy: false, error: reason(err) });
          }
        }}
      >
        Show verification token
      </button>
      {token.value && <code className="copyable">{token.value}</code>}
      {token.error && <StateNote state={{ kind: "partial", detail: token.error }} />}
    </div>
  );
}

/** Off by default: the user names the apps and sites, after the consent wording. */
function ObservationStart({ row, projects, addBlocked, observation }: { row: SourceRow } & ConnectionsProps) {
  const ids = { project: useId(), apps: useId() };
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [apps, setApps] = useState("");
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });
  return (
    <li className="source" data-state={row.state}>
      <CardHead row={row} add={open ? undefined : { label: `Turn on ${row.name}`, disabled: addBlocked !== undefined, onClick: () => setOpen(true) }} />
      {!open ? (
        addBlocked && <p className="quiet small">{addBlocked}</p>
      ) : (
        <form
          className="confirm consent connect-form"
          aria-label={`Turn on ${row.name}`}
          onSubmit={async (e) => {
            e.preventDefault();
            setState({ busy: true });
            try {
              await observation.onStart(list(apps), projectId);
              setOpen(false);
              setState({ busy: false });
            } catch (err) {
              setState({ busy: false, error: reason(err) });
            }
          }}
        >
          <div className="field">
            <label htmlFor={ids.project}>For project</label>
            <select id={ids.project} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.apps}>Apps and sites to read, separated by commas</label>
            <input id={ids.apps} value={apps} autoComplete="off" spellCheck={false} aria-describedby={`${ids.apps}-hint`} onChange={(e) => setApps(e.target.value)} />
            <p id={`${ids.apps}-hint`} className="quiet small">
              An app by its bundle ID, such as com.apple.Notes. A browser site as bundle ID, a bar, then the site: com.google.Chrome|https://docs.google.com
            </p>
          </div>
          <p>{observationConsent}</p>
          <button type="submit" className="secondary" disabled={state.busy || projectId === "" || list(apps).length === 0}>
            Start reading these
          </button>
          <button type="button" className="text-button" onClick={() => setOpen(false)}>
            Cancel
          </button>
          {state.error && <StateNote state={{ kind: "needs-retry", detail: state.error }} />}
        </form>
      )}
    </li>
  );
}
