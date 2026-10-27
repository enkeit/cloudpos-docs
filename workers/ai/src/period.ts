// Resolves named reporting periods into concrete date ranges so the model
// never has to do calendar arithmetic itself. Weeks run Monday–Sunday.

export const PERIODS = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "last_7_days",
  "last_30_days",
  "last_90_days",
  "this_year",
  "custom",
] as const;

export type PeriodName = (typeof PERIODS)[number];

export interface DateRange {
  from: string; // YYYY-MM-DD, inclusive
  to: string; // YYYY-MM-DD, inclusive
  label: string;
}

const DAY_MS = 86_400_000;

/** Today's calendar date (YYYY-MM-DD) in [timeZone]. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function parseDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return formatDate(new Date(parseDate(iso).getTime() + days * DAY_MS));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / DAY_MS) + 1;
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parseDate(value).getTime());
}

/** Monday of the week containing [iso]. */
function weekStart(iso: string): string {
  const dow = (parseDate(iso).getUTCDay() + 6) % 7; // 0 = Monday
  return addDays(iso, -dow);
}

function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function resolvePeriod(
  period: string | undefined,
  today: string,
  custom?: { from?: unknown; to?: unknown },
): DateRange {
  const name = (PERIODS as readonly string[]).includes(period ?? "") ? (period as PeriodName) : "last_30_days";
  switch (name) {
    case "today":
      return { from: today, to: today, label: "Today" };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: y, to: y, label: "Yesterday" };
    }
    case "this_week":
      return { from: weekStart(today), to: today, label: "This week" };
    case "last_week": {
      const start = addDays(weekStart(today), -7);
      return { from: start, to: addDays(start, 6), label: "Last week" };
    }
    case "this_month":
      return { from: monthStart(today), to: today, label: "This month" };
    case "last_month": {
      const end = addDays(monthStart(today), -1);
      return { from: monthStart(end), to: end, label: "Last month" };
    }
    case "last_7_days":
      return { from: addDays(today, -6), to: today, label: "Last 7 days" };
    case "last_90_days":
      return { from: addDays(today, -89), to: today, label: "Last 90 days" };
    case "this_year":
      return { from: `${today.slice(0, 4)}-01-01`, to: today, label: "This year" };
    case "custom": {
      if (isIsoDate(custom?.from) && isIsoDate(custom?.to)) {
        const [from, to] = custom.from <= custom.to ? [custom.from, custom.to] : [custom.to, custom.from];
        return { from, to: to > today ? today : to, label: `${from} to ${to}` };
      }
      return { from: addDays(today, -29), to: today, label: "Last 30 days" };
    }
    case "last_30_days":
    default:
      return { from: addDays(today, -29), to: today, label: "Last 30 days" };
  }
}

/** The equally long range immediately before [range], for comparisons. */
export function previousRange(range: DateRange): DateRange {
  const len = daysBetween(range.from, range.to);
  const to = addDays(range.from, -1);
  const from = addDays(to, -(len - 1));
  return { from, to, label: `Previous ${len} day${len === 1 ? "" : "s"}` };
}

/** Calendar context handed to the model so relative dates are unambiguous. */
export function calendarContext(today: string): string {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(parseDate(today));
  const lw = resolvePeriod("last_week", today);
  const lm = resolvePeriod("last_month", today);
  return `Today is ${weekday} ${today}. This week started ${weekStart(today)}. Last week = ${lw.from}..${lw.to}. Last month = ${lm.from}..${lm.to}.`;
}
