// Narrow typed bridge. The renderer gets these methods only: no fs, shell, network or raw ipcRenderer.
import { contextBridge, ipcRenderer } from "electron";
import type { CaptureInput, CaptureReceipt } from "@companion/domain";
import type { IpcChannel } from "../main/ipc";
import type { LocalSourceKind, LocalSourceView } from "../main/source-watch";

const invoke = (channel: IpcChannel, payload?: unknown) => ipcRenderer.invoke(channel, payload);

const api = {
  saveCapture: (input: CaptureInput): Promise<CaptureReceipt> => invoke("capture:save", input),
  loadPending: (): Promise<CaptureInput[]> => invoke("capture:loadPending"),
  authStatus: (): Promise<{ signedIn: boolean }> => invoke("auth:status"),
  signIn: (): Promise<{ signedIn: boolean }> => invoke("auth:signIn"),
  // Local sources: the main process opens the OS picker; no path ever crosses this bridge.
  chooseSource: (kind: LocalSourceKind, projectIds: string[]): Promise<LocalSourceView | null> =>
    invoke("sources:choose", { kind, projectIds }),
  listSources: (): Promise<LocalSourceView[]> => invoke("sources:list"),
  pauseSource: (sourceId: string): Promise<LocalSourceView> => invoke("sources:pause", { sourceId }),
  resumeSource: (sourceId: string): Promise<LocalSourceView> => invoke("sources:resume", { sourceId }),
  revokeSource: (sourceId: string): Promise<{ id: string; state: "revoked"; version: number }> =>
    invoke("sources:revoke", { sourceId }),
};

export type CompanionApi = typeof api;

contextBridge.exposeInMainWorld("companion", api);
