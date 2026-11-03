// Five-field cron in the rules' time zone: when the next one comes. As in cron, a day of the month and a day of the week
// both given take either, but when either starts with * a day must match both; 0 and 7 are Sunday. A wall-clock moment
// that doesn't exist (clocks going forward) is skipped, and one that happens twice (clocks going back) counts the first
// time, so a schedule fires at most once per wall-clock moment.
const MINUTE = 60_000;
const DAY = 24 * 3600_000;
/** Far enough for a leap day; a schedule with nothing in it never comes. */
const HORIZON = 8 * 366;
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;

export type Cron = { minutes: number[]; hours: number[]; days: Set<number>; months: Set<number>; weekdays: Set<number>; anyDay: boolean; anyWeekday: boolean };

function field(text: string, [min, max]: readonly [number, number]) {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) return null;
    const [, all, from, to, step] = match;
    const start = all === "*" ? min : Number(from);
    const end = all === "*" ? max : to !== undefined ? Number(to) : step !== undefined ? max : start;
    const by = step === undefined ? 1 : Number(step);
    if (start < min || end > max || start > end || by < 1) return null;
    for (let value = start; value <= end; value += by) values.add(value);
  }
  return values;
}

export function parseCron(text: string): Cron | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((part, i) => field(part, RANGES[i]));
  if (sets.some((set) => set === null)) return null;
  const [minutes, hours, days, months, weekdays] = sets as Set<number>[];
  if (weekdays.delete(7)) weekdays.add(0);
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  return { minutes: sorted(minutes), hours: sorted(hours), days, months, weekdays, anyDay: parts[2].startsWith("*"), anyWeekday: parts[4].startsWith("*") };
}

const formats = new Map<string, Intl.DateTimeFormat>();
function wall(ms: number, zone: string) {
  let format = formats.get(zone);
  if (!format) formats.set(zone, format = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }));
  const parts = Object.fromEntries(format.formatToParts(ms).map((p) => [p.type, Number(p.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute };
}

/** How far the zone's clock is ahead of UTC at this moment. */
function offset(ms: number, zone: string) {
  const w = wall(ms, zone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - Math.floor(ms / MINUTE) * MINUTE;
}

/** The first moment this zone's clock reads this, or null if it never does. */
function moment(year: number, month: number, day: number, hour: number, minute: number, zone: string) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const tries = [...new Set([guess - offset(guess - DAY, zone), guess - offset(guess + DAY, zone)])].sort((a, b) => a - b);
  return tries.find((t) => { const w = wall(t, zone); return w.day === day && w.hour === hour && w.minute === minute; }) ?? null;
}

/** The first minute strictly after `after` that the schedule names, or null if it never comes. */
export function nextRun(cron: Cron, after: number, zone: string): number | null {
  const start = wall(after, zone);
  const first = Date.UTC(start.year, start.month - 1, start.day);
  for (let i = 0; i < HORIZON; i++) {
    const date = new Date(first + i * DAY);
    if (!cron.months.has(date.getUTCMonth() + 1)) continue;
    const onDay = cron.days.has(date.getUTCDate()), onWeekday = cron.weekdays.has(date.getUTCDay());
    if (!(cron.anyDay || cron.anyWeekday ? onDay && onWeekday : onDay || onWeekday)) continue;
    for (const hour of cron.hours) {
      if (i === 0 && hour < start.hour) continue;
      for (const minute of cron.minutes) {
        // Earlier on the first day has already happened: a moment counts the first time the clock reads it.
        if (i === 0 && hour === start.hour && minute < start.minute) continue;
        const at = moment(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, zone);
        if (at !== null && at > after) return at;
      }
    }
  }
  return null;
}

/** The last time due at or before `now`, given that `due` was due: what a hub asleep for a while still owes, once. */
export function latestBefore(cron: Cron, due: number, now: number, zone: string) {
  // Looks back over ever wider windows, so a minutely schedule after a year asleep doesn't walk the year.
  for (const window of [3600_000, DAY, 32 * DAY, 400 * DAY, Infinity]) {
    let latest: number | null = null;
    let at: number | null = window === Infinity || now - window < due ? due : nextRun(cron, now - window, zone);
    while (at !== null && at <= now) {
      latest = at;
      at = nextRun(cron, at, zone);
    }
    if (latest !== null) return latest;
  }
  return due;
}

/** When today began in this zone. */
export function dayStart(now: number, zone: string) {
  const w = wall(now, zone);
  return moment(w.year, w.month, w.day, 0, 0, zone) ?? now;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六", "日"];

/** A common schedule in plain words (每天 18:00, 每周日 06:00, 工作日 09:00, 每月 1 日 04:00); any other as written. */
export function describeCron(text: string) {
  const [minute, hour, day, month, weekday] = text.trim().split(/\s+/);
  const number = /^\d+$/;
  if (!number.test(minute) || !number.test(hour) || month !== "*" || !parseCron(text)) return text;
  const at = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (day === "*" && weekday === "*") return `每天 ${at}`;
  if (day === "*" && number.test(weekday)) return `每周${WEEKDAYS[Number(weekday)]} ${at}`;
  if (day === "*" && weekday === "1-5") return `工作日 ${at}`;
  if (number.test(day) && weekday === "*") return `每月 ${Number(day)} 日 ${at}`;
  return text;
}
