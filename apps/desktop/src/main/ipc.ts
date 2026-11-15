// Allowlisted, schema-validated IPC router. Pure: Electron wiring lives in index.ts.
import { z } from "zod";
import { CaptureInputSchema, ProjectIdSchema, type CaptureInput, type CaptureReceipt, type OwnerId } from "@companion/domain";
import { DictationError } from "./dictation";
import { SelfTextSettingSchema, type SelfTextSetting } from "./self-text";

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
    /** Short-lived ID token for the renderer's Convex client; refreshed in main. Null when signed out. */
    idToken(forceRefresh: boolean): Promise<string | null>;
  };
  store: Store;
  /** Local file sources; paths come only from the OS dialog in the main process. */
  sources: {
    choose(ownerId: OwnerId, input: SourceChoice): Promise<unknown>;
    list(ownerId: OwnerId): unknown;
    pause(ownerId: OwnerId, sourceId: string): Promise<unknown>;
    resume(ownerId: OwnerId, sourceId: string): Promise<unknown>;
    revoke(ownerId: OwnerId, sourceId: string): Promise<unknown>;
    setCloudProcessing(ownerId: OwnerId, sourceId: string, enabled: boolean): Promise<unknown>;
    /** Text observation of the apps/sites the user selected (selectors validated below). */
    observe(ownerId: OwnerId, input: ObservationChoice): Promise<unknown>;
    deleteRetained(ownerId: OwnerId, sourceId: string): Promise<unknown>;
    /** Opens the OS file dialog in main and records the chosen note as this grant's log write target. */
    designateLog(ownerId: OwnerId, sourceId: string): Promise<unknown>;
  };
  /** Companion dictation; begin is bound to the window that called it (microphone permission). */
  dictation: {
    begin(senderId: number): Promise<{ microphone: "granted" | "denied" }>;
    finish(audio: Uint8Array, mime: string): Promise<{ text: string; recoveryId: string }>;
    retry(recoveryId: string): Promise<{ text: string; recoveryId: string }>;
    discard(recoveryId: string): Promise<unknown>;
    acknowledge(recoveryId: string): Promise<unknown>;
    listRecoverable(): Promise<unknown>;
  };
  shortcut: { status(): unknown; set(accelerator: string): unknown };
  /** Nudge texts to the user's own number; the test text goes only to the saved handle. */
  selfText: { get(): unknown; set(setting: SelfTextSetting): unknown; sendTest(): Promise<unknown> };
  /** OS hand-offs, each called only from a user's click. */
  system: { openExternal(url: string): Promise<void>; openAccessibilitySettings(): Promise<void>; openMicrophoneSettings(): Promise<void> };
  /** The held talk key (native helper): which key, and whether macOS lets it work. */
  talkKey: { status(): unknown };
  /** Event-driven hand-off of consented local evidence to the cloud. */
  cloud: { trigger(): Promise<void> };
  /** Window control. Called only from the user's own pointer and key input in the renderer; never on a timer. */
  windows: {
    openPanel(projectId?: string): void;
    openApp(projectId?: string): void;
    closePanel(): void;
    setPetVisible(visible: boolean): void;
    petVisible(): boolean;
    /** Moves the pet by a step if `senderId` is the pet window; main clamps it onto a display. */
    dragPet(senderId: number, dx: number, dy: number): void;
    /** The pointer entered or left the calling window; main knows whether that is the pet or the panel. */
    pointerOver(senderId: number, over: boolean): void;
    /** The button went down on the pet's figure, or came up in place ("up") or after a drag ("dragged"). */
    petPress(senderId: number, phase: PetPress): void;
    /** Opens the panel pinned with the capture box focused; a dictation transcript, if any, goes into it to edit. */
    openCapture(transcript?: Transcript): void;
  };
};

/** Who called: the frame's URL for the origin check, the window's id for window-bound permissions. */
export type IpcSender = { frameUrl: string | undefined; senderId?: number };

const SourceChoiceSchema = z.strictObject({
  kind: z.enum(["obsidian", "claude-code", "codex"]),
  projectIds: z.array(ProjectIdSchema).min(1),
});
type SourceChoice = z.infer<typeof SourceChoiceSchema>;
const SourceRefSchema = z.strictObject({ sourceId: z.string().min(1).max(100) });
type SourceRef = z.infer<typeof SourceRefSchema>;
const CloudConsentSchema = SourceRefSchema.extend({ enabled: z.boolean() });
type CloudConsent = z.infer<typeof CloudConsentSchema>;
// Keep in step with observation.ts: `bundleId` for an app, `bundleId|origin` for one site in a browser.
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;
const isSelector = (selector: string) => {
  const [id = "", origin, ...rest] = selector.split("|");
  if (!BUNDLE_ID.test(id) || rest.length > 0) return false;
  if (origin === undefined) return true;
  return URL.canParse(origin) && /^https?:$/.test(new URL(origin).protocol) && new URL(origin).origin === origin;
};
const ObservationChoiceSchema = z.strictObject({
  selectors: z.array(z.string().max(512).refine(isSelector)).min(1).max(50),
  projectIds: z.array(ProjectIdSchema).min(1),
});
type ObservationChoice = z.infer<typeof ObservationChoiceSchema>;
const RECOVERY_ID = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const RecoveryRefSchema = z.strictObject({ recoveryId: RECOVERY_ID });
type RecoveryRef = z.infer<typeof RecoveryRefSchema>;
const FinishSchema = z.strictObject({ bytes: z.instanceof(Uint8Array), mime: z.string().min(1).max(100) });
type Finish = z.infer<typeof FinishSchema>;
// A global shortcut must hold a modifier: a bare key would swallow ordinary typing in every app.
const AcceleratorSchema = z.strictObject({
  accelerator: z
    .string()
    .max(100)
    .regex(/^(?:(?:Command|Cmd|Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|Shift|Super|Meta)\+)+[A-Za-z0-9]+$/)
    .refine((a) => /(?:Command|Cmd|Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|Super|Meta)\+/.test(a)),
});
/** Only these sign-in pages may open in the system browser: Google, Microsoft, and Composio's hosted connect link. */
const AUTH_ORIGINS = new Set(["https://accounts.google.com", "https://login.microsoftonline.com", "https://connect.composio.dev"]);
const isAuthUrl = (raw: string) => {
  if (!URL.canParse(raw)) return false;
  const url = new URL(raw);
  return AUTH_ORIGINS.has(url.origin) && url.port === "" && url.username === "" && url.password === "";
};
const ExternalAuthSchema = z.strictObject({ url: z.string().max(4096).refine(isAuthUrl) });

/** Dictation failures cross IPC as data: Electron would pass only the message, losing the recovery id. */
async function dictationResult(run: Promise<{ text: string; recoveryId: string }>) {
  try {
    return { ok: true as const, ...(await run) };
  } catch (err) {
    if (!(err instanceof DictationError)) throw err;
    return { ok: false as const, code: err.code, ...(err.recoveryId ? { recoveryId: err.recoveryId } : {}) };
  }
}

const WindowTargetSchema = z.strictObject({ projectId: ProjectIdSchema.optional() });
type WindowTarget = z.infer<typeof WindowTargetSchema>;
// One pointer-move or key step, in px. Larger than any display, so a fast drag is never refused.
const step = z.number().int().min(-4000).max(4000);
const DragSchema = z.strictObject({ dx: step, dy: step });
type Drag = z.infer<typeof DragSchema>;

const PetPressSchema = z.strictObject({ phase: z.enum(["down", "up", "dragged"]) });
type PetPress = z.infer<typeof PetPressSchema>["phase"];
// A transcript only ever lands in the editable capture box; nothing here saves it.
const TranscriptSchema = z.strictObject({ text: z.string().min(1).max(50_000), recoveryId: RECOVERY_ID });
type Transcript = z.infer<typeof TranscriptSchema>;
const OpenCaptureSchema = z.strictObject({ transcript: TranscriptSchema.optional() });

/** Window-bound requests: main checks which window sent them, never the renderer's say-so. */
function requireSender(sender: IpcSender): number {
  if (sender.senderId === undefined) throw new IpcRejected("Untrusted sender");
  return sender.senderId;
}

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
  "sources:choose": {
    payload: SourceChoiceSchema,
    run: (deps: IpcRouterDeps, input: SourceChoice) => deps.sources.choose(requireOwner(deps), input),
  },
  "sources:list": {
    payload: z.undefined(),
    run: async (deps: IpcRouterDeps) => deps.sources.list(requireOwner(deps)),
  },
  "sources:pause": {
    payload: SourceRefSchema,
    run: (deps: IpcRouterDeps, { sourceId }: SourceRef) => deps.sources.pause(requireOwner(deps), sourceId),
  },
  "sources:resume": {
    payload: SourceRefSchema,
    run: (deps: IpcRouterDeps, { sourceId }: SourceRef) => deps.sources.resume(requireOwner(deps), sourceId),
  },
  "sources:revoke": {
    payload: SourceRefSchema,
    run: (deps: IpcRouterDeps, { sourceId }: SourceRef) => deps.sources.revoke(requireOwner(deps), sourceId),
  },
  "sources:setCloudProcessing": {
    payload: CloudConsentSchema,
    run: (deps: IpcRouterDeps, { sourceId, enabled }: CloudConsent) =>
      deps.sources.setCloudProcessing(requireOwner(deps), sourceId, enabled),
  },
  "observation:start": {
    payload: ObservationChoiceSchema,
    run: (deps: IpcRouterDeps, input: ObservationChoice) => deps.sources.observe(requireOwner(deps), input),
  },
  "observation:deleteRetained": {
    payload: SourceRefSchema,
    run: (deps: IpcRouterDeps, { sourceId }: SourceRef) => deps.sources.deleteRetained(requireOwner(deps), sourceId),
  },
  "observation:openAccessibilitySettings": {
    payload: z.undefined(),
    run: (deps: IpcRouterDeps) => deps.system.openAccessibilitySettings(),
  },
  "logs:designate": {
    payload: SourceRefSchema,
    run: (deps: IpcRouterDeps, { sourceId }: SourceRef) => deps.sources.designateLog(requireOwner(deps), sourceId),
  },
  "dictation:begin": {
    payload: z.undefined(),
    run: async (deps: IpcRouterDeps, _: undefined, sender: IpcSender) => {
      requireOwner(deps);
      return deps.dictation.begin(requireSender(sender));
    },
  },
  "dictation:finish": {
    payload: FinishSchema,
    run: (deps: IpcRouterDeps, { bytes, mime }: Finish) => {
      requireOwner(deps);
      return dictationResult(deps.dictation.finish(bytes, mime));
    },
  },
  "dictation:retry": {
    payload: RecoveryRefSchema,
    run: (deps: IpcRouterDeps, { recoveryId }: RecoveryRef) => {
      requireOwner(deps);
      return dictationResult(deps.dictation.retry(recoveryId));
    },
  },
  "dictation:discard": {
    payload: RecoveryRefSchema,
    run: async (deps: IpcRouterDeps, { recoveryId }: RecoveryRef) => {
      requireOwner(deps);
      await deps.dictation.discard(recoveryId);
    },
  },
  "dictation:acknowledge": {
    payload: RecoveryRefSchema,
    run: async (deps: IpcRouterDeps, { recoveryId }: RecoveryRef) => {
      requireOwner(deps);
      await deps.dictation.acknowledge(recoveryId);
    },
  },
  "dictation:listRecoverable": {
    payload: z.undefined(),
    run: (deps: IpcRouterDeps) => {
      requireOwner(deps);
      return deps.dictation.listRecoverable();
    },
  },
  // Shortcut and auth hand-off need no owner: they act only on this Mac's own settings and browser.
  "shortcut:status": {
    payload: z.undefined(),
    run: async (deps: IpcRouterDeps) => deps.shortcut.status(),
  },
  "shortcut:set": {
    payload: AcceleratorSchema,
    run: async (deps: IpcRouterDeps, { accelerator }: { accelerator: string }) => deps.shortcut.set(accelerator),
  },
  "selfText:get": {
    payload: z.undefined(),
    run: async (deps: IpcRouterDeps) => deps.selfText.get(),
  },
  "selfText:set": {
    payload: SelfTextSettingSchema,
    run: async (deps: IpcRouterDeps, setting: SelfTextSetting) => deps.selfText.set(setting),
  },
  "selfText:test": {
    payload: z.undefined(),
    run: (deps: IpcRouterDeps) => deps.selfText.sendTest(),
  },
  "auth:openExternal": {
    payload: ExternalAuthSchema,
    run: (deps: IpcRouterDeps, { url }: { url: string }) => deps.system.openExternal(url),
  },
  "cloud:online": {
    payload: z.undefined(),
    run: async (deps: IpcRouterDeps) => void deps.cloud.trigger(),
  },
  // Window routes need no owner: they show what the renderer already subscribes to.
  "window:openPanel": {
    payload: WindowTargetSchema,
    run: async (deps: IpcRouterDeps, { projectId }: WindowTarget) => deps.windows.openPanel(projectId),
  },
  "window:openApp": {
    payload: WindowTargetSchema,
    run: async (deps: IpcRouterDeps, { projectId }: WindowTarget) => deps.windows.openApp(projectId),
  },
  "window:closePanel": {
    payload: z.undefined(),
    run: async (deps: IpcRouterDeps) => deps.windows.closePanel(),
  },
  "pet:setVisible": {
    payload: z.strictObject({ visible: z.boolean() }),
    run: async (deps: IpcRouterDeps, { visible }: { visible: boolean }) => deps.windows.setPetVisible(visible),
  },
  "pet:visible": {
    payload: z.undefined(),
    run: async (deps: IpcRouterDeps) => deps.windows.petVisible(),
  },
  "pet:dragBy": {
    payload: DragSchema,
    run: async (deps: IpcRouterDeps, { dx, dy }: Drag, sender: IpcSender) => deps.windows.dragPet(requireSender(sender), dx, dy),
  },
  "window:hover": {
    payload: z.strictObject({ over: z.boolean() }),
    run: async (deps: IpcRouterDeps, { over }: { over: boolean }, sender: IpcSender) => deps.windows.pointerOver(requireSender(sender), over),
  },
  "pet:press": {
    payload: PetPressSchema,
    run: async (deps: IpcRouterDeps, { phase }: { phase: PetPress }, sender: IpcSender) => deps.windows.petPress(requireSender(sender), phase),
  },
  "capture:open": {
    payload: OpenCaptureSchema,
    run: async (deps: IpcRouterDeps, { transcript }: { transcript?: Transcript }) => deps.windows.openCapture(transcript),
  },
  "dictation:openMicrophoneSettings": {
    payload: z.undefined(),
    run: (deps: IpcRouterDeps) => deps.system.openMicrophoneSettings(),
  },
  "talk:keyStatus": {
    payload: z.undefined(),
    run: async (deps: IpcRouterDeps) => deps.talkKey.status(),
  },
  "auth:idToken": {
    payload: z.strictObject({ forceRefresh: z.boolean() }),
    run: (deps: IpcRouterDeps, { forceRefresh }: { forceRefresh: boolean }) => deps.auth.idToken(forceRefresh),
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
    async handle(channel: string, sender: IpcSender, payload: unknown): Promise<unknown> {
      if (!Object.hasOwn(routes, channel)) throw new IpcRejected("Unknown IPC channel");
      if (!isTrustedFrame(deps.appOrigin, sender.frameUrl)) throw new IpcRejected("Untrusted sender");
      const route = routes[channel as IpcChannel];
      const parsed = route.payload.safeParse(payload);
      if (!parsed.success) throw new IpcRejected("Invalid request");
      return route.run(deps, parsed.data as never, sender as never);
    },
  };
}
