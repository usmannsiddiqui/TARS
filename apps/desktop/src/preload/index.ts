// Narrow typed bridge. The renderer gets these methods only: no fs, shell, network or raw ipcRenderer.
import { contextBridge, ipcRenderer } from "electron";
import type { CaptureInput, CaptureReceipt } from "@companion/domain";
import { DICTATION_LIMITS } from "../main/dictation-limits";
import type { DictationErrorCode, Recoverable } from "../main/dictation";
import type { HoldKeyStatus } from "../main/hold-key";
import type { IpcChannel } from "../main/ipc";
import type { SelfTextResult, SelfTextSetting } from "../main/self-text";
import type { ShortcutStatus } from "../main/shortcut";
import type { LocalSourceKind, LocalSourceView, SourceStatus } from "../main/source-watch";

const invoke = (channel: IpcChannel, payload?: unknown) => ipcRenderer.invoke(channel, payload);
/** Main-to-renderer pushes carry only an optional project id; anything else arrives as null. */
const projectIdOf = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
const listen = (channel: "app:navigate", callback: (projectId: string | null) => void) => {
  const handler = (_event: unknown, value: unknown) => callback(projectIdOf(value));
  ipcRenderer.on(channel, handler);
  return () => void ipcRenderer.removeListener(channel, handler);
};
const subscribe = <T>(channel: "observation:status" | "talk:keyStatus" | "talk:key", callback: (value: T) => void) => {
  const handler = (_event: unknown, value: T) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => void ipcRenderer.removeListener(channel, handler);
};

/** A transcript for the editable composer, or why not; recoveryId (when set) can be retried or discarded. */
export type DictationResult = { ok: true; text: string; recoveryId: string } | { ok: false; code: DictationErrorCode; recoveryId?: string };
export type ObservationStatusEvent = { sourceId: string } & SourceStatus;
export type Transcript = { text: string; recoveryId: string };
/** What the panel opens on: a project, and whether on the capture box, with a transcript to edit. */
export type PanelShowing = { projectId: string | null; capture: boolean; transcript?: Transcript };
const showingOf = (value: unknown): PanelShowing => {
  const v = (value ?? {}) as Record<string, unknown>;
  const t = (v["transcript"] ?? {}) as Record<string, unknown>;
  const transcript = typeof t["text"] === "string" && typeof t["recoveryId"] === "string" ? { text: t["text"], recoveryId: t["recoveryId"] } : undefined;
  return { projectId: projectIdOf(v["projectId"]), capture: v["capture"] === true, ...(transcript ? { transcript } : {}) };
};
export type { HoldKeyStatus };
/** The saved setting (handle "" until the user saves one) and how this run's last nudge text went. */
export type SelfTextView = { enabled: boolean; handle: string; lastNudge?: SelfTextResult };

const api = {
  saveCapture: (input: CaptureInput): Promise<CaptureReceipt> => invoke("capture:save", input),
  loadPending: (): Promise<CaptureInput[]> => invoke("capture:loadPending"),
  authStatus: (): Promise<{ signedIn: boolean }> => invoke("auth:status"),
  signIn: (): Promise<{ signedIn: boolean }> => invoke("auth:signIn"),
  // Only the short-lived ID token, for the Convex client; the refresh token stays in the main process.
  idToken: (forceRefresh: boolean): Promise<string | null> => invoke("auth:idToken", { forceRefresh }),
  cloudOnline: (): Promise<void> => invoke("cloud:online"),
  // Local sources: the main process opens the OS picker; no path ever crosses this bridge.
  chooseSource: (kind: LocalSourceKind, projectIds: string[]): Promise<LocalSourceView | null> =>
    invoke("sources:choose", { kind, projectIds }),
  listSources: (): Promise<LocalSourceView[]> => invoke("sources:list"),
  pauseSource: (sourceId: string): Promise<LocalSourceView> => invoke("sources:pause", { sourceId }),
  resumeSource: (sourceId: string): Promise<LocalSourceView> => invoke("sources:resume", { sourceId }),
  setCloudProcessing: (sourceId: string, enabled: boolean): Promise<LocalSourceView> =>
    invoke("sources:setCloudProcessing", { sourceId, enabled }),
  revokeSource: (sourceId: string): Promise<{ id: string; state: "revoked"; version: number }> =>
    invoke("sources:revoke", { sourceId }),
  // Windows: call these only from the user's own clicks or key presses.
  openPanel: (projectId?: string): Promise<void> => invoke("window:openPanel", projectId ? { projectId } : {}),
  /** Opens the panel on the capture box; a dictation transcript goes into it to edit, never saved by this. */
  openCapture: (transcript?: Transcript): Promise<void> => invoke("capture:open", transcript ? { transcript } : {}),
  openApp: (projectId?: string): Promise<void> => invoke("window:openApp", projectId ? { projectId } : {}),
  closePanel: (): Promise<void> => invoke("window:closePanel"),
  setPetVisible: (visible: boolean): Promise<void> => invoke("pet:setVisible", { visible }),
  /** The persisted hide-pet choice. */
  petVisible: (): Promise<boolean> => invoke("pet:visible"),
  /** Moves the pet by whole px (a drag step or an arrow key); main clamps it and remembers where it is. */
  dragPet: (dx: number, dy: number): Promise<void> => invoke("pet:dragBy", { dx, dy }),
  /** The pointer entered or left this window; main opens or closes the panel from that. */
  pointerOver: (over: boolean): Promise<void> => invoke("window:hover", { over }),
  /** The button went down on the pet's figure, came up in place, or came up after a drag. */
  petPress: (phase: "down" | "up" | "dragged"): Promise<void> => invoke("pet:press", { phase }),
  // Opens Google or Microsoft sign-in in the system browser; any other URL is refused by main.
  openExternalAuth: (url: string): Promise<void> => invoke("auth:openExternal", { url }),
  // Dictation: begin only on a Record click; the mic is allowed for this window only after begin.
  dictation: {
    limits: DICTATION_LIMITS,
    begin: (): Promise<{ microphone: "granted" | "denied" }> => invoke("dictation:begin"),
    finish: (bytes: Uint8Array, mime: string): Promise<DictationResult> => invoke("dictation:finish", { bytes, mime }),
    retry: (recoveryId: string): Promise<DictationResult> => invoke("dictation:retry", { recoveryId }),
    discard: (recoveryId: string): Promise<void> => invoke("dictation:discard", { recoveryId }),
    /** Call only after the composer text is durably saved. */
    acknowledge: (recoveryId: string): Promise<void> => invoke("dictation:acknowledge", { recoveryId }),
    listRecoverable: (): Promise<Recoverable[]> => invoke("dictation:listRecoverable"),
    /** Call only from the user's click: opens System Settings > Microphone; nothing is requested. */
    openMicrophoneSettings: (): Promise<void> => invoke("dictation:openMicrophoneSettings"),
  },
  // Hold to talk with a key held anywhere (native helper; needs Accessibility). Only down/up arrive.
  talk: {
    keyStatus: (): Promise<HoldKeyStatus> => invoke("talk:keyStatus"),
    onKeyStatus: (callback: (status: HoldKeyStatus) => void) => subscribe("talk:keyStatus", callback),
    onKey: (callback: (down: boolean) => void) => subscribe<unknown>("talk:key", (down) => callback(down === true)),
    /** Call only from the user's click: opens System Settings > Accessibility; nothing is requested. */
    openAccessibilitySettings: (): Promise<void> => invoke("observation:openAccessibilitySettings"),
  },
  shortcut: {
    status: (): Promise<ShortcutStatus> => invoke("shortcut:status"),
    set: (accelerator: string): Promise<ShortcutStatus> => invoke("shortcut:set", { accelerator }),
  },
  // Nudge texts to the user's own number through Messages; the saved handle is the only recipient.
  selfText: {
    get: (): Promise<SelfTextView> => invoke("selfText:get"),
    set: (setting: SelfTextSetting): Promise<SelfTextSetting> => invoke("selfText:set", setting),
    /** Call only from the user's click: sends a fixed sentence to the saved handle. */
    sendTest: (): Promise<SelfTextResult> => invoke("selfText:test"),
  },
  // Outcome log: main opens the file dialog; the result names the note only by an opaque id.
  designateLogNote: (sourceId: string): Promise<{ sourceId: string; target: string; name: string } | null> =>
    invoke("logs:designate", { sourceId }),
  // Observation of user-selected apps ("bundleId") or browser sites ("bundleId|https://origin").
  observation: {
    list: async (): Promise<LocalSourceView[]> =>
      ((await invoke("sources:list")) as LocalSourceView[]).filter((s) => s.kind === "observation"),
    start: (selectors: string[], projectIds: string[]): Promise<LocalSourceView> =>
      invoke("observation:start", { selectors, projectIds }),
    pause: (sourceId: string): Promise<LocalSourceView> => invoke("sources:pause", { sourceId }),
    resume: (sourceId: string): Promise<LocalSourceView> => invoke("sources:resume", { sourceId }),
    revoke: (sourceId: string): Promise<{ id: string; state: "revoked"; version: number }> => invoke("sources:revoke", { sourceId }),
    deleteRetained: (sourceId: string): Promise<void> => invoke("observation:deleteRetained", { sourceId }),
    /** Call only from the user's click: opens System Settings > Accessibility; nothing is requested. */
    openAccessibilitySettings: (): Promise<void> => invoke("observation:openAccessibilitySettings"),
    onStatus: (callback: (status: ObservationStatusEvent) => void) => subscribe("observation:status", callback),
  },
  onNavigate: (callback: (projectId: string | null) => void) => listen("app:navigate", callback),
  onPanelShow: (callback: (showing: PanelShowing) => void) => {
    const handler = (_event: unknown, value: unknown) => callback(showingOf(value));
    ipcRenderer.on("panel:show", handler);
    return () => void ipcRenderer.removeListener("panel:show", handler);
  },
};

export type CompanionApi = typeof api;

contextBridge.exposeInMainWorld("companion", api);
