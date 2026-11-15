// TARS's own calendar: what it will do on its own (only deadlines really scheduled), what it did (from
// stored timestamps) and what needs a look. Presentational: the entries come from tarsCalendar().
import { byDay, type CalendarEntry, type Honest } from "./model";
import { kindOfName, SourceChip } from "./logos";
import { formatWhen, StateNote, StateTag } from "./ui";

export type TarsCalendarProps = {
  /** undefined while loading. */
  calendar: { upcoming: CalendarEntry[]; done: CalendarEntry[]; attention: CalendarEntry[] } | undefined;
  cloud?: Honest;
  now: number;
};

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** An entry's title with its source's name shown as that source's chip ("Checked [Notion]"). */
function Title({ entry }: { entry: CalendarEntry }) {
  const kind = entry.source && kindOfName(entry.source);
  if (!entry.source || !kind) return <p className="agenda-title">{entry.title}</p>;
  const at = entry.title.indexOf(entry.source);
  if (at < 0) return <p className="agenda-title">{entry.title}</p>;
  return (
    <p className="agenda-title">
      {entry.title.slice(0, at)}
      <SourceChip kind={kind} label={entry.source} />
      {entry.title.slice(at + entry.source.length)}
    </p>
  );
}

function Entries({ entries, withDay }: { entries: CalendarEntry[]; withDay?: boolean }) {
  return (
    <ul className="agenda inner">
      {entries.map((e) => (
        <li key={`${e.title}:${e.at}`} className="agenda-row">
          <span className="agenda-time num">{withDay ? formatWhen(new Date(e.at).toISOString()) : time.format(e.at)}</span>
          <div className="agenda-body">
            <Title entry={e} />
            {e.detail && <p className="quiet small">{e.detail}</p>}
          </div>
          <span className="agenda-state">
            <StateTag state={e.state} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function TarsCalendar({ calendar, cloud, now }: TarsCalendarProps) {
  const pending = cloud ?? (calendar === undefined ? ({ kind: "loading", detail: "Reading what TARS has scheduled…" } as const) : undefined);
  return (
    <div className="screen">
      <header className="screen-head">
        <h1>TARS's calendar</h1>
        <p className="screen-sub">What TARS does on its own: briefs it prepares, sources it checks, work it prepared for you.</p>
        {calendar && (
          <ul className="readout" aria-label="TARS's calendar now">
            <li>
              <span className="readout-key">Coming up</span> {calendar.upcoming.length}
            </li>
            <li>
              <span className="readout-key">Done</span> {calendar.done.length}
            </li>
            <li>
              <span className="readout-key">Needs a look</span> {calendar.attention.length}
            </li>
          </ul>
        )}
      </header>
      {pending ? (
        <section className="block calendar-state">
          <StateNote state={pending} />
        </section>
      ) : (
        calendar && (
          <div className="calendar-grid">
            <div className="calendar-main">
              <section className="block" aria-labelledby="upcoming-h">
                <h2 id="upcoming-h" className="block-title">
                  Coming up
                </h2>
                {calendar.upcoming.length === 0 ? (
                  <StateNote
                    state={{
                      kind: "empty",
                      detail: "No brief is scheduled yet. TARS schedules the morning brief and the evening recap once it knows your time zone, which Today sets when you are signed in.",
                    }}
                  />
                ) : (
                  <Entries entries={calendar.upcoming} withDay />
                )}
              </section>
              <section className="block" aria-labelledby="done-h">
                <h2 id="done-h" className="block-title">
                  Done on its own
                </h2>
                {calendar.done.length === 0 ? (
                  <StateNote state={{ kind: "empty", detail: "Briefs, source checks and preparations appear here with the time they happened." }} />
                ) : (
                  byDay(calendar.done, (e) => e.at, now).map((day) => (
                    <section key={day.key} className="calendar-day" aria-label={day.label}>
                      <h3 className="group-title">{day.label}</h3>
                      <Entries entries={day.items} />
                    </section>
                  ))
                )}
              </section>
            </div>
            <section className="block" aria-labelledby="attention-h">
              <h2 id="attention-h" className="block-title">
                Needs a look
              </h2>
              {calendar.attention.length === 0 ? (
                <StateNote state={{ kind: "empty", detail: "Nothing needs a look." }} />
              ) : (
                <ul className="plain">
                  {calendar.attention.map((e) => (
                    <li key={`${e.title}:${e.at}`}>
                      <Title entry={e} />
                      <StateNote state={e.state} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )
      )}
    </div>
  );
}
