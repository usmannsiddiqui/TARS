// Allowlisted, schema-validated IPC router. Pure: Electron wiring lives in index.ts.
import { z } from "zod";
import { CaptureInputSchema, type CaptureInput, type CaptureReceipt, type OwnerId } from "@companion/domain";

/** Thrown for any request the main process refuses; the message is safe to show. */
export class IpcRejected extends Error {
  override name = "IpcRejected";
}

type Store = {
  saveCapture(input: CaptureInput, ownerId: OwnerId): Promise<CaptureReceipt>;
  loadPending(ownerId: OwnerId): Promise<CaptureInput[]>;
};

export type IpcRouterDeps = {
  /** The only origin whose frames may call the API, e.g. "app://companion". */
  appOrigin: string;
  auth: {
    /** Owner from the verified signed-in session; null when signed out. */
    currentOwner(): OwnerId | null;
    signIn(): Promise<void>;
  };
  store: Store;
};

// Payload schemas per channel. None accepts an ownerId: the main process supplies it.
const routes = {
  "capture:save": {
    payload: CaptureInputSchema,
    run: (deps: IpcRouterDeps, input: CaptureInput) => deps.store.saveCapture(input, requireOwner(deps)),
  },
  "capture:loadPending": {
    payload: z.undefined(),
    run: (deps: IpcRouterDeps) => deps.store.loadPending(requireOwner(deps)),
  },
  "auth:status": {
    payload: z.undefined(),
    run: async (deps: IpcRouterDeps) => ({ signedIn: deps.auth.currentOwner() !== null }),
  },
  "auth:signIn": {
    payload: z.undefined(),
    run: async (deps: IpcRouterDeps) => {
      await deps.auth.signIn();
      return { signedIn: deps.auth.currentOwner() !== null };
    },
  },
} as const;

export type IpcChannel = keyof typeof routes;
export const IPC_CHANNELS = Object.keys(routes) as IpcChannel[];

function requireOwner(deps: IpcRouterDeps): OwnerId {
  const owner = deps.auth.currentOwner();
  if (!owner) throw new IpcRejected("Not signed in");
  return owner;
}

function isTrustedFrame(appOrigin: string, frameUrl: string | undefined): boolean {
  if (!frameUrl || !URL.canParse(frameUrl)) return false;
  // WHATWG URL reports an opaque "null" origin for custom schemes like app://, so compare scheme+host.
  const url = new URL(frameUrl);
  return `${url.protocol}//${url.host}` === appOrigin;
}

export function createIpcRouter(deps: IpcRouterDeps) {
  return {
    async handle(channel: string, sender: { frameUrl: string | undefined }, payload: unknown): Promise<unknown> {
      if (!Object.hasOwn(routes, channel)) throw new IpcRejected("Unknown IPC channel");
      if (!isTrustedFrame(deps.appOrigin, sender.frameUrl)) throw new IpcRejected("Untrusted sender");
      const route = routes[channel as IpcChannel];
      const parsed = route.payload.safeParse(payload);
      if (!parsed.success) throw new IpcRejected("Invalid request");
      return route.run(deps, parsed.data as never);
    },
  };
}
