// The user's schedule: meetings and real due dates across projects from the morning brief, grouped by
// day, each with its source and how fresh that is. Suggestions are not deadlines and never appear here.
// Presentational: data arrives as props.
import { byDay, type HardItem, type Honest } from "./model";
import { SourceChip } from "./logos";
import { formatWhen, SOURCE_NAME, StateNote } from "./ui";

export type ScheduleProps = {
  /** The morning brief's meetings and deadlines: undefined while loading, null when none is prepared yet. */
  brief: { hard: HardItem[]; preparedAt: number } | null | undefined;
  /** When the next morning brief is scheduled, if it is. */
  nextBriefAt?: number;
  cloud?: Honest;
  now: number;
  nameOf(projectId: string): string | undefined;
};

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export function Schedule({ brief, nextBriefAt, cloud, now, nameOf }: ScheduleProps) {
  const items = [...(brief?.hard ?? [])].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const days = byDay(items, (i) => Date.parse(i.dueAt), now);
  const next = nextBriefAt ? formatWhen(new Date(nextBriefAt).toISOString()) : undefined;
  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Schedule</h1>
        <p className="screen-sub">Meetings and real due dates from your sources. Suggestions are not deadlines and never appear here.</p>
        <ul className="readout" aria-label="Schedule now">
          <li>
            <span className="readout-key">Meetings and deadlines</span> {brief ? items.length : "none yet"}
          </li>
          <li>
            <span className="readout-key">From the brief</span> {brief ? `prepared ${formatWhen(new Date(brief.preparedAt).toISOString())}` : "not prepared yet"}
          </li>
        </ul>
      </header>
      <div className="days">
        {cloud ? (
          <section className="block">
            <StateNote state={cloud} />
          </section>
        ) : brief === undefined ? (
          <section className="block">
            <StateNote state={{ kind: "loading", detail: "Reading the morning brief…" }} />
          </section>
        ) : brief === null ? (
          <section className="block">
            <StateNote state={{ kind: "empty", detail: next ? `Your schedule comes from the morning brief. The next one is prepared ${next}.` : "No morning brief is scheduled yet, so there is no schedule to show." }} />
          </section>
        ) : days.length === 0 ? (
          <section className="block">
            <StateNote state={{ kind: "empty", detail: "No meetings or due dates in your sources." }} />
          </section>
        ) : (
          days.map((day) => (
            <section key={day.key} className="block day" aria-labelledby={`day-${day.key}`}>
              <h2 id={`day-${day.key}`} className="block-title">
                {day.label}
              </h2>
              <ul className="agenda inner">
                {day.items.map((item) => (
                  <li key={item.commitmentId} className="agenda-row">
                    <span className="agenda-time num">{time.format(Date.parse(item.dueAt))}</span>
                    <div className="agenda-body">
                      <p className="agenda-title">{item.text}</p>
                      <p className="quiet small">
                        {item.kind === "meeting" ? "Meeting" : "Due"} · {nameOf(item.projectId) ?? "a project"} ·{" "}
                        {item.sourceKind ? (
                          <>
                            from <SourceChip kind={item.sourceKind} label={SOURCE_NAME[item.sourceKind] ?? item.sourceKind} />
                          </>
                        ) : (
                          "no linked source"
                        )}
                      </p>
                      {item.sourceKind && !item.current ? (
                        <StateNote state={{ kind: "stale", detail: `${item.lastCheckedAt ? `last checked ${formatWhen(item.lastCheckedAt)}` : "never checked"}; may have changed` }} />
                      ) : (
                        item.lastCheckedAt && <StateNote state={{ kind: "last-checked", at: item.lastCheckedAt }} />
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
