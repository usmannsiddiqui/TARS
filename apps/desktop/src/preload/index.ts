// Narrow typed bridge. The renderer gets these methods only: no fs, shell, network or raw ipcRenderer.
import { contextBridge, ipcRenderer } from "electron";
import type { CaptureInput, CaptureReceipt } from "@companion/domain";
import { DICTATION_LIMITS } from "../main/dictation-limits";
import type { DictationErrorCode, Recoverable } from "../main/dictation";
import type { IpcChannel } from "../main/ipc";
import type { ShortcutStatus } from "../main/shortcut";
import type { LocalSourceKind, LocalSourceView, SourceStatus } from "../main/source-watch";

const invoke = (channel: IpcChannel, payload?: unknown) => ipcRenderer.invoke(channel, payload);
/** Main-to-renderer pushes carry only an optional project id; anything else arrives as null. */
const listen = (channel: "app:navigate" | "panel:show", callback: (projectId: string | null) => void) => {
  const handler = (_event: unknown, value: unknown) => callback(typeof value === "string" && value !== "" ? value : null);
  ipcRenderer.on(channel, handler);
  return () => void ipcRenderer.removeListener(channel, handler);
};
const subscribe = <T>(channel: "observation:status" | "capture:open", callback: (value: T) => void) => {
  const handler = (_event: unknown, value: T) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => void ipcRenderer.removeListener(channel, handler);
};

/** A transcript for the editable composer, or why not; recoveryId (when set) can be retried or discarded. */
export type DictationResult = { ok: true; text: string; recoveryId: string } | { ok: false; code: DictationErrorCode; recoveryId?: string };
export type ObservationStatusEvent = { sourceId: string } & SourceStatus;

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
  openApp: (projectId?: string): Promise<void> => invoke("window:openApp", projectId ? { projectId } : {}),
  closePanel: (): Promise<void> => invoke("window:closePanel"),
  setPetVisible: (visible: boolean): Promise<void> => invoke("pet:setVisible", { visible }),
  /** The persisted hide-pet choice. */
  petVisible: (): Promise<boolean> => invoke("pet:visible"),
  /** Moves the pet by whole px (a drag step or an arrow key); main clamps it and remembers where it is. */
  dragPet: (dx: number, dy: number): Promise<void> => invoke("pet:dragBy", { dx, dy }),
  /** The pointer entered or left this window; main opens or closes the panel from that. */
  pointerOver: (over: boolean): Promise<void> => invoke("window:hover", { over }),
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
  },
  shortcut: {
    status: (): Promise<ShortcutStatus> => invoke("shortcut:status"),
    set: (accelerator: string): Promise<ShortcutStatus> => invoke("shortcut:set", { accelerator }),
  },
  /** The shortcut opened the panel for capture: focus the composer (never start recording). */
  onCaptureOpen: (callback: () => void) => subscribe("capture:open", () => callback()),
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
  onPanelShow: (callback: (projectId: string | null) => void) => listen("panel:show", callback),
};

export type CompanionApi = typeof api;

contextBridge.exposeInMainWorld("companion", api);
