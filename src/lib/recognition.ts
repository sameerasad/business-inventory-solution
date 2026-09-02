import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { MONTH_LABELS } from "@/lib/format";
import {
  currentMonthIndex0,
  currentYear,
  dayRange,
  monthRange,
  todayUtc,
  yearRange,
} from "@/lib/dates";
import type { Breakdown, Money, Scope } from "@/lib/queries";

/**
 * Revenue and profit on a CASH basis.
 *
 * A booking deducts stock the moment it is taken, but it is not treated as
 * earned revenue until the money arrives. Delivering goods on credit is not the
 * same as being paid for them, and this is the file that draws that line.
 *
 * Two kinds of recognition event:
 *
 *  1. A payment against a booking. The payment is allocated across that
 *     booking's lines in proportion to their value, so a Rs 20,000 payment on a
 *     Rs 45,000 order recognises 20,000/45,000 of every line - its revenue, its
 *     cost, and therefore its profit. The date used is the PAYMENT date, so the
 *     money lands in the month it was received, not the month of delivery.
 *
 *  2. A sale recorded on the New Sale page (no booking). That is an
 *     over-the-counter cash sale: money changed hands there and then, so it is
 *     recognised in full on its sale date.
 *
 * Nothing is stored. These figures are derived from payments, sales and batches
 * on every read, exactly as profit always has been.
 */

/**
 * Payments capped so a booking can never recognise more than it invoiced.
 *
 * The running window sums every earlier payment on the same booking; whatever
 * is left of the invoice value is the most this payment may recognise. Without
 * this, an overpayment - or a booking whose sales were deleted behind its
 * payments - would inflate revenue above what was ever billed.
 */
const RECOGNITION = Prisma.sql`
  WITH booking_totals AS (
    SELECT
      s.booking_id,
      SUM(s.sale_price * s.quantity) AS total
    FROM sales s
    JOIN batches b ON b.id = s.batch_id
    WHERE s.is_deleted = false
      AND b.is_deleted = false
      AND s.booking_id IS NOT NULL
    GROUP BY s.booking_id
  ),
  capped_payments AS (
    SELECT
      p.booking_id,
      bk.booker_id,
      p.paid_on,
      LEAST(
        p.amount,
        GREATEST(
          0,
          bt.total - COALESCE(
            SUM(p.amount) OVER (
              PARTITION BY p.booking_id
              ORDER BY p.paid_on, p.id
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
            ),
            0
          )
        )
      ) AS amount,
      bt.total
    FROM payments p
    JOIN bookings bk ON bk.id = p.booking_id AND bk.is_deleted = false
    JOIN booking_totals bt ON bt.booking_id = p.booking_id
    WHERE p.is_deleted = false AND bt.total > 0
  ),
  recognised AS (
    -- 1. Cash received against a booking, spread across its lines pro rata.
    SELECT
      cp.paid_on                                                            AS on_date,
      cp.booker_id                                                          AS booker_id,
      s.product_id                                                          AS product_id,
      s.area_id                                                             AS area_id,
      s.shop_id                                                             AS shop_id,
      (s.sale_price * s.quantity) * cp.amount / cp.total                    AS revenue,
      ((s.sale_price - b.unit_cost) * s.quantity) * cp.amount / cp.total    AS profit
    FROM capped_payments cp
    JOIN sales s ON s.booking_id = cp.booking_id AND s.is_deleted = false
    JOIN batches b ON b.id = s.batch_id AND b.is_deleted = false
    WHERE cp.amount > 0

    UNION ALL

    -- 2. Counter sales: paid at the till, so recognised in full on the day.
    --    Nobody books a counter sale, so there is no booker to credit it to.
    SELECT
      s.sale_date,
      NULL::int,
      s.product_id,
      s.area_id,
      s.shop_id,
      s.sale_price * s.quantity,
      (s.sale_price - b.unit_cost) * s.quantity
    FROM sales s
    JOIN batches b ON b.id = s.batch_id
    WHERE s.booking_id IS NULL
      AND s.is_deleted = false
      AND b.is_deleted = false
  )
`;

const REVENUE = Prisma.sql`COALESCE(SUM(r.revenue), 0)::float8`;
const PROFIT = Prisma.sql`COALESCE(SUM(r.profit), 0)::float8`;

/** DATE columns compare against explicit ::date literals, never a timestamp. */
function d(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The cash queries take one dimension the accrual queries in queries.ts do not:
 * the booker. It is a separate type rather than an optional field on Scope so a
 * bookerId can never be passed to a query that would silently ignore it.
 */
export type CashScope = Scope & { bookerId: number | null };

function where(scope: CashScope): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`r.on_date >= ${d(scope.start)}::date`,
    Prisma.sql`r.on_date < ${d(scope.end)}::date`,
  ];
  if (scope.categoryId != null) parts.push(Prisma.sql`p.category_id = ${scope.categoryId}`);
  if (scope.areaId != null) parts.push(Prisma.sql`r.area_id = ${scope.areaId}`);
  // A counter sale has no booker, so filtering by one correctly excludes them:
  // that money was not booked by anybody.
  if (scope.bookerId != null) parts.push(Prisma.sql`r.booker_id = ${scope.bookerId}`);
  return Prisma.sql`WHERE ${Prisma.join(parts, " AND ")}`;
}

/** Every aggregate joins products, since the category filter lives there. */
const FROM_RECOGNISED = Prisma.sql`
  FROM recognised r
  JOIN products p ON p.id = r.product_id
`;

/* ----------------------------------------------------------------- KPI totals */

async function totals(scope: CashScope): Promise<{ revenue: number; profit: number }> {
  const rows = await prisma.$queryRaw<{ revenue: number; profit: number }[]>(Prisma.sql`
    ${RECOGNITION}
    SELECT ${REVENUE} AS revenue, ${PROFIT} AS profit
    ${FROM_RECOGNISED}
    ${where(scope)}
  `);
  return rows[0] ?? { revenue: 0, profit: 0 };
}

/**
 * Units DELIVERED in the period - a physical count, dated by the sale date.
 *
 * Deliberately not on the cash basis: a part-paid order did not ship 44.4 packs.
 * The dashboard labels this separately for exactly that reason.
 */
async function deliveredUnits(scope: CashScope): Promise<number> {
  const parts: Prisma.Sql[] = [
    Prisma.sql`s.is_deleted = false`,
    Prisma.sql`b.is_deleted = false`,
    Prisma.sql`s.sale_date >= ${d(scope.start)}::date`,
    Prisma.sql`s.sale_date < ${d(scope.end)}::date`,
  ];
  if (scope.categoryId != null) parts.push(Prisma.sql`p.category_id = ${scope.categoryId}`);
  if (scope.areaId != null) parts.push(Prisma.sql`s.area_id = ${scope.areaId}`);
  // Counter sales have no booking and therefore no booker, so a booker filter
  // excludes them here too - consistent with the revenue figures beside it.
  if (scope.bookerId != null) parts.push(Prisma.sql`bk.booker_id = ${scope.bookerId}`);

  const rows = await prisma.$queryRaw<{ units: number }[]>(Prisma.sql`
    SELECT COALESCE(SUM(s.quantity), 0)::int AS units
    FROM sales s
    JOIN batches b ON b.id = s.batch_id
    JOIN products p ON p.id = s.product_id
    LEFT JOIN bookings bk ON bk.id = s.booking_id
    WHERE ${Prisma.join(parts, " AND ")}
  `);
  return rows[0]?.units ?? 0;
}

export type CashKpis = {
  today: Money;
  month: Money;
  year: Money;
  isCurrentYear: boolean;
  monthLabel: string;
  /** Delivered but not yet paid for: the revenue still to be earned. */
  awaitingPayment: number;
};

export async function getCashKpis(filters: {
  year: number;
  categoryId: number | null;
  areaId: number | null;
  bookerId: number | null;
}): Promise<CashKpis> {
  const { year, categoryId, areaId, bookerId } = filters;
  const isCurrentYear = year === currentYear();
  const yr = yearRange(year);
  const monthIndex0 = isCurrentYear ? currentMonthIndex0() : 11;
  const mr = monthRange(year, monthIndex0);
  const dr = dayRange(todayUtc());

  const [yearT, monthT, todayT, yearUnits, monthUnits, todayUnits, awaiting] = await Promise.all([
    totals({ ...yr, categoryId, areaId, bookerId }),
    totals({ ...mr, categoryId, areaId, bookerId }),
    isCurrentYear
      ? totals({ ...dr, categoryId, areaId, bookerId })
      : Promise.resolve({ revenue: 0, profit: 0 }),
    deliveredUnits({ ...yr, categoryId, areaId, bookerId }),
    deliveredUnits({ ...mr, categoryId, areaId, bookerId }),
    isCurrentYear ? deliveredUnits({ ...dr, categoryId, areaId, bookerId }) : Promise.resolve(0),
    getAwaitingPayment({ areaId, bookerId }),
  ]);

  return {
    today: { ...todayT, units: todayUnits },
    month: { ...monthT, units: monthUnits },
    year: { ...yearT, units: yearUnits },
    isCurrentYear,
    monthLabel: `${MONTH_LABELS[monthIndex0]} ${year}`,
    awaitingPayment: awaiting,
  };
}

/**
 * Value of goods delivered on bookings that has not been paid for yet - the
 * revenue sitting in the pipeline. Capped the same way, so an overpaid or
 * broken booking cannot push it negative.
 */
export async function getAwaitingPayment(filters: {
  areaId: number | null;
  bookerId?: number | null;
}): Promise<number> {
  const areaClause =
    filters.areaId != null ? Prisma.sql`AND bk.area_id = ${filters.areaId}` : Prisma.empty;
  const bookerClause =
    filters.bookerId != null ? Prisma.sql`AND bk.booker_id = ${filters.bookerId}` : Prisma.empty;

  const rows = await prisma.$queryRaw<{ awaiting: number }[]>(Prisma.sql`
    SELECT COALESCE(SUM(GREATEST(0, t.total - COALESCE(pay.paid, 0))), 0)::float8 AS awaiting
    FROM bookings bk
    JOIN (
      SELECT s.booking_id, SUM(s.sale_price * s.quantity) AS total
      FROM sales s
      JOIN batches b ON b.id = s.batch_id
      WHERE s.is_deleted = false AND b.is_deleted = false AND s.booking_id IS NOT NULL
      GROUP BY s.booking_id
    ) t ON t.booking_id = bk.id
    LEFT JOIN (
      SELECT p.booking_id, SUM(p.amount) AS paid
      FROM payments p WHERE p.is_deleted = false
      GROUP BY p.booking_id
    ) pay ON pay.booking_id = bk.id
    WHERE bk.is_deleted = false ${areaClause} ${bookerClause}
  `);
  return rows[0]?.awaiting ?? 0;
}

/* ---------------------------------------------------------------- month trend */

export type CashMonthPoint = { month: number; label: string; revenue: number; profit: number };

export async function getCashMonthlyTrend(filters: {
  year: number;
  categoryId: number | null;
  areaId: number | null;
  bookerId: number | null;
}): Promise<CashMonthPoint[]> {
  const scope: CashScope = {
    ...yearRange(filters.year),
    categoryId: filters.categoryId,
    areaId: filters.areaId,
    bookerId: filters.bookerId,
  };
  const rows = await prisma.$queryRaw<{ month: number; revenue: number; profit: number }[]>(
    Prisma.sql`
      ${RECOGNITION}
      SELECT
        EXTRACT(MONTH FROM r.on_date)::int AS month,
        ${REVENUE} AS revenue,
        ${PROFIT}  AS profit
      ${FROM_RECOGNISED}
      ${where(scope)}
      GROUP BY 1
      ORDER BY 1
    `,
  );

  const byMonth = new Map(rows.map((r) => [r.month, r]));
  return MONTH_LABELS.map((label, i) => {
    const row = byMonth.get(i + 1);
    return { month: i + 1, label, revenue: row?.revenue ?? 0, profit: row?.profit ?? 0 };
  });
}

/* ----------------------------------------------------------------- breakdowns */

async function breakdown(
  scope: CashScope,
  groupExpr: Prisma.Sql,
  extraJoins?: Prisma.Sql,
  limit?: number,
): Promise<Breakdown[]> {
  const rows = await prisma.$queryRaw<
    { bucket: string | null; revenue: number; profit: number }[]
  >(Prisma.sql`
    ${RECOGNITION}
    SELECT
      ${groupExpr} AS bucket,
      ${REVENUE} AS revenue,
      ${PROFIT}  AS profit
    ${FROM_RECOGNISED}
    ${extraJoins ?? Prisma.empty}
    ${where(scope)}
    GROUP BY 1
    ORDER BY revenue DESC
    ${limit ? Prisma.sql`LIMIT ${limit}` : Prisma.empty}
  `);
  return rows.map<Breakdown>((r) => ({
    key: r.bucket ?? "unknown",
    label: r.bucket ?? "Unknown",
    revenue: r.revenue,
    profit: r.profit,
    // Units are a physical count and do not belong on the cash basis, so the
    // breakdown tooltips no longer show one.
    units: 0,
  }));
}

export function getCashByPackaging(scope: CashScope) {
  return breakdown(scope, Prisma.sql`p.packaging_type`);
}

function variantSortKey(label: string): number {
  const match = /^([\d.]+)\s*([a-z]*)/i.exec(label.trim());
  if (!match) return Number.MAX_SAFE_INTEGER;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  const unit = match[2].toLowerCase();
  const scale = unit === "ml" || unit === "l" ? 1 : 0.001;
  return value * (unit === "l" ? 1000 : 1) * scale;
}

export async function getCashByVariant(scope: CashScope): Promise<Breakdown[]> {
  const rows = await breakdown(scope, Prisma.sql`p.variant_value`);
  return rows.sort((a, b) => variantSortKey(a.label) - variantSortKey(b.label));
}

export function getCashByProductName(scope: CashScope) {
  return breakdown(scope, Prisma.sql`p.name`);
}

export function getCashByCategory(scope: CashScope) {
  return breakdown(
    scope,
    Prisma.sql`c.name`,
    Prisma.sql`JOIN categories c ON c.id = p.category_id`,
  );
}

export function getCashByArea(scope: CashScope) {
  return breakdown(scope, Prisma.sql`a.name`, Prisma.sql`JOIN areas a ON a.id = r.area_id`);
}

export function getCashByShop(scope: CashScope, limit = 10) {
  return breakdown(
    scope,
    Prisma.sql`COALESCE(sh.name, ${"Direct Sale (no shop)"})`,
    Prisma.sql`LEFT JOIN shops sh ON sh.id = r.shop_id`,
    limit,
  );
}

/**
 * Cash revenue and profit per booker.
 *
 * Counter sales have no booker, so rather than dropping them - which would make
 * this chart disagree with every other total on the page - they appear as their
 * own row, the same way a shopless sale does in the shop chart.
 */
export function getCashByBooker(scope: CashScope, limit?: number) {
  return breakdown(
    scope,
    Prisma.sql`COALESCE(bo.name, ${"Counter sale (no booker)"})`,
    Prisma.sql`LEFT JOIN bookers bo ON bo.id = r.booker_id`,
    limit,
  );
}

/** Years that have either a payment or a counter sale in them. */
export async function getCashYears(): Promise<number[]> {
  const rows = await prisma.$queryRaw<{ year: number }[]>(Prisma.sql`
    SELECT DISTINCT EXTRACT(YEAR FROM p.paid_on)::int AS year
      FROM payments p
      JOIN bookings b ON b.id = p.booking_id
      WHERE p.is_deleted = false AND b.is_deleted = false
    UNION
    SELECT DISTINCT EXTRACT(YEAR FROM s.sale_date)::int AS year
      FROM sales s
      WHERE s.is_deleted = false AND s.booking_id IS NULL
    UNION
    SELECT DISTINCT EXTRACT(YEAR FROM s.sale_date)::int AS year
      FROM sales s WHERE s.is_deleted = false
  `);
  const years = new Set(rows.map((r) => r.year));
  years.add(currentYear());
  return [...years].sort((a, b) => b - a);
}
