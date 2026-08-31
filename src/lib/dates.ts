/**
 * Every date the business cares about (received_date, sale_date) is a calendar
 * day, not an instant. Those columns are Postgres DATE and we always build the
 * JS Date at UTC midnight so the stored day matches what the user typed,
 * regardless of the server timezone.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function parseDateOnly(input: string): Date {
  if (!DATE_ONLY.test(input)) {
    throw new Error(`Expected a YYYY-MM-DD date, got "${input}"`);
  }
  const d = new Date(`${input}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date "${input}"`);
  }
  return d;
}

export function isDateOnly(input: string): boolean {
  if (!DATE_ONLY.test(input)) return false;
  const d = new Date(`${input}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && input === d.toISOString().slice(0, 10);
}

export function utcDate(year: number, monthIndex0: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex0, day, 0, 0, 0, 0));
}

/** [start, endExclusive) covering a whole calendar year. */
export function yearRange(year: number): { start: Date; end: Date } {
  return { start: utcDate(year, 0, 1), end: utcDate(year + 1, 0, 1) };
}

/** [start, endExclusive) covering one calendar month. monthIndex0 is 0-11. */
export function monthRange(year: number, monthIndex0: number): { start: Date; end: Date } {
  return { start: utcDate(year, monthIndex0, 1), end: utcDate(year, monthIndex0 + 1, 1) };
}

/** [start, endExclusive) covering a single day. */
export function dayRange(date: Date): { start: Date; end: Date } {
  const start = utcDate(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/** "Now" reduced to the calendar day, as a UTC-midnight Date. */
export function todayUtc(): Date {
  const now = new Date();
  return utcDate(now.getFullYear(), now.getMonth(), now.getDate());
}

export function currentYear(): number {
  return new Date().getFullYear();
}

export function currentMonthIndex0(): number {
  return new Date().getMonth();
}
