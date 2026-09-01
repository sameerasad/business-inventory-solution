/**
 * Currency and locale for the whole app. Every figure on every page and chart is
 * formatted through the helpers below, so changing these two lines is all it
 * takes to switch currency.
 *
 * "en-PK" renders PKR as "Rs 450"; the "en-US" locale would render the same
 * amount as "PKR 450", which reads like a spreadsheet export.
 */
export const CURRENCY = { locale: "en-PK", code: "PKR" } as const;

const wholeCurrency = new Intl.NumberFormat(CURRENCY.locale, {
  style: "currency",
  currency: CURRENCY.code,
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const preciseCurrency = new Intl.NumberFormat(CURRENCY.locale, {
  style: "currency",
  currency: CURRENCY.code,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactCurrency = new Intl.NumberFormat(CURRENCY.locale, {
  style: "currency",
  currency: CURRENCY.code,
  notation: "compact",
  maximumFractionDigits: 1,
});

const integer = new Intl.NumberFormat(CURRENCY.locale);

/**
 * Rupee amounts are normally whole, so paisa are shown only when the value
 * actually has some: "Rs 450", but "Rs 12.50". Always forcing two decimals
 * would put ".00" on nearly every figure in the app.
 */
export function money(value: number | null | undefined): string {
  const amount = value ?? 0;
  return Number.isInteger(amount)
    ? wholeCurrency.format(amount)
    : preciseCurrency.format(amount);
}

/** For chart axes, where "Rs 12.5K" beats "Rs 12,543". */
export function moneyCompact(value: number | null | undefined): string {
  return compactCurrency.format(value ?? 0);
}

export function qty(value: number | null | undefined): string {
  return integer.format(value ?? 0);
}

export function percent(part: number, whole: number): string {
  if (!whole) return "0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/**
 * Formats a DATE column for display. Prisma hands back `@db.Date` values as a
 * JS Date pinned to UTC midnight, so we must read the UTC parts - using the
 * local getters would shift the day backwards west of Greenwich.
 */
export function dateOnly(value: Date | string | null | undefined): string {
  if (!value) return "-";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "-";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Same as dateOnly, but shaped for an <input type="date"> value. */
export const toDateInputValue = dateOnly;

export function dateTime(value: Date | string | null | undefined): string {
  if (!value) return "-";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString(CURRENCY.locale, { dateStyle: "medium", timeStyle: "short" });
}

export const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** Today in the server timezone, as YYYY-MM-DD, for date-input defaults. */
export function todayInputValue(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
