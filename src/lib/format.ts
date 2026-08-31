const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const compactCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

const integer = new Intl.NumberFormat("en-US");

export function money(value: number | null | undefined): string {
  return currency.format(value ?? 0);
}

/** For chart axes, where "$12.5K" beats "$12,543.00". */
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
  return d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
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
