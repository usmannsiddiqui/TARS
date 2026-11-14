// Narrow typed bridge. The renderer gets these methods only: no fs, shell, network or raw ipcRenderer.
import { contextBridge, ipcRenderer } from "electron";
import type { CaptureInput, CaptureReceipt } from "@companion/domain";
import type { IpcChannel } from "../main/ipc";
import type { LocalSourceKind, LocalSourceView } from "../main/source-watch";

const invoke = (channel: IpcChannel, payload?: unknown) => ipcRenderer.invoke(channel, payload);
/** Main-to-renderer pushes carry only an optional project id; anything else arrives as null. */
const listen = (channel: "app:navigate" | "panel:show", callback: (projectId: string | null) => void) => {
  const handler = (_event: unknown, value: unknown) => callback(typeof value === "string" && value !== "" ? value : null);
  ipcRenderer.on(channel, handler);
  return () => void ipcRenderer.removeListener(channel, handler);
};

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
  onNavigate: (callback: (projectId: string | null) => void) => listen("app:navigate", callback),
  onPanelShow: (callback: (projectId: string | null) => void) => listen("panel:show", callback),
};

export type CompanionApi = typeof api;

contextBridge.exposeInMainWorld("companion", api);
