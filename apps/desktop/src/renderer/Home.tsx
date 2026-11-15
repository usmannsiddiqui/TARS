// Today as one thread with TARS (todayThread): the way back in or the morning brief, each helper run,
// a nudge or tradeoff to answer, his captures and their sort, the evening recap; the composer docked
// under it. Built from subscriptions that already exist; nothing new is stored. Presentational: data and
// actions arrive as props.
import { useEffect, useRef } from "react";
import type { BrainDumpProps } from "./BrainDump";
import { Composer } from "./Composer";
import type { HelperActions } from "./Helpers";
import { todayThread, type Honest, type NudgeChoice, type ProjectSummary, type TodayInput, type TradeoffChoice } from "./model";
import { Thread } from "./Thread";
import { StateNote } from "./ui";

export type HomeProps = Omit<TodayInput, "projects" | "dump"> & {
  /** null while projects are unavailable; `cloud` then says why. */
  projects: ProjectSummary[] | null;
  cloud?: Honest;
  focusProjectId?: string;
  helperActions: HelperActions;
  /** Sorting a saved capture into projects: its words and sort show in the thread. */
  brainDump?: BrainDumpProps;
  /** A capture was saved on this Mac: reload the list of ideas. */
  onCaptured(): void;
  onStart(projectId: string, mode: "help" | "improve"): void;
  onOpenProject(projectId: string): void;
  /** A brief or nudge was actually shown here, so it is never offered as news again. */
  onBriefShown(key: string): void;
  onResolveTradeoff(commitmentId: string, choice: TradeoffChoice): Promise<void>;
  onNudge(choice: NudgeChoice): Promise<void>;
};

export function Home(props: HomeProps) {
  const { projects, brief, reentry, nudge, brainDump, onBriefShown } = props;
  const shownKey = !reentry && brief && !brief.delivered ? brief.key : undefined;
  const nudgeKey = nudge && !nudge.delivered ? nudge.key : undefined;
  const reported = useRef(new Set<string>());
  useEffect(() => {
    for (const key of [shownKey, nudgeKey]) {
      if (!key || reported.current.has(key)) continue; // one report per showing
      reported.current.add(key);
      onBriefShown(key);
    }
  }, [shownKey, nudgeKey, onBriefShown]);

  const said = brainDump?.said;
  const thread =
    projects === null
      ? null
      : todayThread({
          ...props,
          projects,
          ...(said ? { dump: { ...said, ...(brainDump?.view ? { view: brainDump.view } : {}) } } : {}),
        });

  return (
    <div className="screen chat-screen">
      <div className="chat-scroll">
        {thread === null ? (
          <div className="thread-empty">
            <StateNote state={props.cloud ?? { kind: "loading" }} />
            <p>You can still message TARS; it waits safely on this Mac.</p>
          </div>
        ) : (
          <Thread
            messages={thread}
            label="Today with TARS"
            actions={{
              onStart: props.onStart,
              onOpenProject: props.onOpenProject,
              onChoose: async (askId, choiceId) => {
                const [kind, id = ""] = askId.split(/:(.*)/);
                if (kind === "nudge") await props.onNudge(choiceId as NudgeChoice);
                else if (kind === "tradeoff") await props.onResolveTradeoff(id, choiceId as TradeoffChoice);
                else if (kind === "run") await (choiceId === "retry" ? props.helperActions.onRetry(id) : props.helperActions.onDismiss(id));
              },
              ...(brainDump ? { dump: brainDump } : {}),
            }}
          />
        )}
      </div>
      <div className="dock">
        <Composer pill {...(props.focusProjectId ? { projectId: props.focusProjectId } : {})} onSaved={props.onCaptured} {...(brainDump ? { brainDump } : {})} />
      </div>
    </div>
  );
}
