// The held talk key, from the native holdkey helper (native/observer, target HoldKey). The helper watches
// one modifier through a listen-only NSEvent monitor, which macOS allows only with Accessibility access.
// Every line is schema-validated; only "down", "up" and a status word reach the app. No polling, no restart
// loop: a helper that exits is reported as unavailable and stays so until the app restarts.
import { createInterface } from "node:readline";
import { z } from "zod";
import type { HelperChild } from "./observation";

export const HOLD_KEY = "Right Option (⌥)";
export type HoldKeyStatus = { key: string; state: "starting" | "ready" | "permission-missing" | "unavailable" };

const MAX_LINE = 256;
const LineSchema = z.union([
  z.strictObject({ type: z.literal("hold"), down: z.boolean() }),
  z.strictObject({ type: z.literal("status"), status: z.enum(["ready", "permission-missing"]) }),
]);

export function startHoldKey(deps: {
  spawn(): HelperChild;
  onHold(down: boolean): void;
  onStatus(status: HoldKeyStatus): void;
  diagnostic?(message: string): void;
}) {
  const diagnostic = deps.diagnostic ?? ((m: string) => console.warn(`holdkey: ${m}`));
  let status: HoldKeyStatus = { key: HOLD_KEY, state: "starting" };
  let down = false;
  let stopped = false;
  const setStatus = (state: HoldKeyStatus["state"]) => {
    status = { key: HOLD_KEY, state };
    deps.onStatus(status);
  };
  const hold = (next: boolean) => {
    if (next === down) return;
    down = next;
    deps.onHold(next);
  };
  const gone = () => {
    if (stopped) return;
    hold(false); // never leave a recording running on a helper that died mid-hold
    setStatus("unavailable");
  };

  const child = deps.spawn();
  child.once("exit", gone);
  child.once("error", gone);
  child.stdin.on("error", () => diagnostic("helper input closed"));
  createInterface({ input: child.stderr }).on("line", (line) => diagnostic(line.slice(0, 200)));
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (stopped) return;
    if (line.length > MAX_LINE) return diagnostic("helper line too long");
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return diagnostic("malformed helper line");
    }
    const parsed = LineSchema.safeParse(raw);
    if (!parsed.success) return diagnostic("invalid helper line");
    if (parsed.data.type === "hold") return hold(parsed.data.down);
    if (parsed.data.status !== "ready") hold(false);
    setStatus(parsed.data.status);
  });

  return {
    status: () => status,
    stop() {
      stopped = true;
      child.stdin.end();
      child.kill();
    },
  };
}
