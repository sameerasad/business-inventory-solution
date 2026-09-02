import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { yearRange } from "@/lib/dates";

/**
 * Per-booker performance.
 *
 * The metrics are chosen around one idea: booking an order is the easy half.
 * A booker who writes big orders and never collects is a liability, not a star,
 * so collection and ageing sit next to booked value rather than behind it.
 *
 * Nothing here is stored. Every figure is derived from bookings, sales and
 * payments at read time.
 */

export type BookerOption = {
  id: number;
  name: string;
  code: string | null;
};

export async function getActiveBookers(): Promise<BookerOption[]> {
  return prisma.booker.findMany({
    where: { isDeleted: false, isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, code: true },
  });
}

export type BookerRow = {
  id: number;
  name: string;
  code: string | null;
  phone: string | null;
  notes: string | null;
  isActive: boolean;
  /** Bookings taken in the period. */
  bookings: number;
  /** Invoice value of those bookings. */
  bookedValue: number;
  /** Full margin on them, if every one were paid. */
  bookedProfit: number;
  /** Cash actually received against them. */
  collected: number;
  /** Still owed on them. */
  outstanding: number;
  /** Of that, owed for more than 30 days. */
  overdue: number;
  /** collected / bookedValue, as a percentage. */
  collectionRate: number | null;
  areasCovered: number;
  shopsCovered: number;
  units: number;
  avgOrderValue: number | null;
  /** Mean days from booking to final payment, for bookings fully settled. */
  avgDaysToSettle: number | null;
  lastBookingDate: Date | null;
};

/**
 * One query per booker would be N+1 and the numbers would not tie together, so
 * this assembles every metric in a single pass over the period's bookings.
 */
export async function getBookerPerformance(filters: {
  year: number;
  areaId: number | null;
}): Promise<{
  rows: BookerRow[];
  totals: {
    bookings: number;
    bookedValue: number;
    collected: number;
    outstanding: number;
    unattributed: number;
  };
}> {
  const { start, end } = yearRange(filters.year);
  const from = start.toISOString().slice(0, 10);
  const to = end.toISOString().slice(0, 10);
  const areaClause =
    filters.areaId != null ? Prisma.sql`AND bk.area_id = ${filters.areaId}` : Prisma.empty;

  const rows = await prisma.$queryRaw<BookerRow[]>(Prisma.sql`
    WITH period_bookings AS (
      SELECT
        bk.id,
        bk.booker_id,
        bk.area_id,
        bk.shop_id,
        bk.booking_date,
        COALESCE(t.total, 0)  AS total,
        COALESCE(t.profit, 0) AS profit,
        COALESCE(t.units, 0)  AS units,
        COALESCE(pay.paid, 0) AS paid,
        pay.last_paid_on
      FROM bookings bk
      LEFT JOIN (
        SELECT
          s.booking_id,
          SUM(s.sale_price * s.quantity)                  AS total,
          SUM((s.sale_price - b.unit_cost) * s.quantity)   AS profit,
          SUM(s.quantity)                                 AS units
        FROM sales s
        JOIN batches b ON b.id = s.batch_id
        WHERE s.is_deleted = false AND b.is_deleted = false AND s.booking_id IS NOT NULL
        GROUP BY s.booking_id
      ) t ON t.booking_id = bk.id
      LEFT JOIN (
        SELECT p.booking_id, SUM(p.amount) AS paid, MAX(p.paid_on) AS last_paid_on
        FROM payments p WHERE p.is_deleted = false
        GROUP BY p.booking_id
      ) pay ON pay.booking_id = bk.id
      WHERE bk.is_deleted = false
        AND bk.booking_date >= ${from}::date
        AND bk.booking_date <  ${to}::date
        ${areaClause}
    )
    SELECT
      bo.id                                        AS "id",
      bo.name                                      AS "name",
      bo.code                                      AS "code",
      bo.phone                                     AS "phone",
      bo.notes                                     AS "notes",
      bo.is_active                                 AS "isActive",
      COUNT(pb.id)::int                            AS "bookings",
      COALESCE(SUM(pb.total), 0)::float8           AS "bookedValue",
      COALESCE(SUM(pb.profit), 0)::float8          AS "bookedProfit",
      COALESCE(SUM(LEAST(pb.paid, pb.total)), 0)::float8 AS "collected",
      COALESCE(SUM(GREATEST(0, pb.total - pb.paid)), 0)::float8 AS "outstanding",
      -- Overdue is the part of the balance on orders older than 30 days.
      COALESCE(SUM(
        CASE WHEN CURRENT_DATE - pb.booking_date > 30
             THEN GREATEST(0, pb.total - pb.paid) ELSE 0 END
      ), 0)::float8                                AS "overdue",
      CASE WHEN COALESCE(SUM(pb.total), 0) > 0
           THEN (COALESCE(SUM(LEAST(pb.paid, pb.total)), 0) / SUM(pb.total) * 100)::float8
           END                                     AS "collectionRate",
      COUNT(DISTINCT pb.area_id)::int              AS "areasCovered",
      COUNT(DISTINCT pb.shop_id)::int              AS "shopsCovered",
      COALESCE(SUM(pb.units), 0)::int              AS "units",
      CASE WHEN COUNT(pb.id) > 0
           THEN (COALESCE(SUM(pb.total), 0) / COUNT(pb.id))::float8
           END                                     AS "avgOrderValue",
      -- Only bookings that are actually settled tell you anything about speed.
      AVG(
        CASE WHEN pb.total > 0 AND pb.paid >= pb.total - 0.005 AND pb.last_paid_on IS NOT NULL
             THEN (pb.last_paid_on - pb.booking_date)
             END
      )::float8                                    AS "avgDaysToSettle",
      MAX(pb.booking_date)                         AS "lastBookingDate"
    FROM bookers bo
    LEFT JOIN period_bookings pb ON pb.booker_id = bo.id
    WHERE bo.is_deleted = false
    GROUP BY bo.id, bo.name, bo.code, bo.phone, bo.notes, bo.is_active
    ORDER BY "bookedValue" DESC, bo.name ASC
  `);

  // Bookings with no booker attached - everything taken before this module
  // existed, plus anything recorded without picking one.
  const unattributedRows = await prisma.$queryRaw<{ value: number }[]>(Prisma.sql`
    SELECT COALESCE(SUM(t.total), 0)::float8 AS value
    FROM bookings bk
    LEFT JOIN (
      SELECT s.booking_id, SUM(s.sale_price * s.quantity) AS total
      FROM sales s
      WHERE s.is_deleted = false AND s.booking_id IS NOT NULL
      GROUP BY s.booking_id
    ) t ON t.booking_id = bk.id
    WHERE bk.is_deleted = false
      AND bk.booker_id IS NULL
      AND bk.booking_date >= ${from}::date
      AND bk.booking_date <  ${to}::date
      ${areaClause}
  `);

  return {
    rows,
    totals: {
      bookings: rows.reduce((s, r) => s + r.bookings, 0),
      bookedValue: rows.reduce((s, r) => s + r.bookedValue, 0),
      collected: rows.reduce((s, r) => s + r.collected, 0),
      outstanding: rows.reduce((s, r) => s + r.outstanding, 0),
      unattributed: unattributedRows[0]?.value ?? 0,
    },
  };
}

/**
 * Which areas and shops a booker actually reached in the period. Coverage is
 * the question "is anyone visiting the north side?", which a single count
 * cannot answer.
 */
export async function getBookerCoverage(filters: { year: number }): Promise<
  { bookerId: number; bookerName: string; areaName: string; shops: number; value: number }[]
> {
  const { start, end } = yearRange(filters.year);
  return prisma.$queryRaw(Prisma.sql`
    SELECT
      bo.id                                        AS "bookerId",
      bo.name                                      AS "bookerName",
      a.name                                       AS "areaName",
      COUNT(DISTINCT bk.shop_id)::int              AS "shops",
      COALESCE(SUM(t.total), 0)::float8            AS "value"
    FROM bookings bk
    JOIN bookers bo ON bo.id = bk.booker_id
    JOIN areas a ON a.id = bk.area_id
    LEFT JOIN (
      SELECT s.booking_id, SUM(s.sale_price * s.quantity) AS total
      FROM sales s
      WHERE s.is_deleted = false AND s.booking_id IS NOT NULL
      GROUP BY s.booking_id
    ) t ON t.booking_id = bk.id
    WHERE bk.is_deleted = false
      AND bo.is_deleted = false
      AND bk.booking_date >= ${start.toISOString().slice(0, 10)}::date
      AND bk.booking_date <  ${end.toISOString().slice(0, 10)}::date
    GROUP BY bo.id, bo.name, a.name
    ORDER BY bo.name, "value" DESC
  `);
}

/** Areas nobody booked in this period - the gap in coverage. */
export async function getUncoveredAreas(filters: { year: number }): Promise<string[]> {
  const { start, end } = yearRange(filters.year);
  const rows = await prisma.$queryRaw<{ name: string }[]>(Prisma.sql`
    SELECT a.name
    FROM areas a
    WHERE a.is_deleted = false
      AND NOT EXISTS (
        SELECT 1 FROM bookings bk
        WHERE bk.area_id = a.id
          AND bk.is_deleted = false
          AND bk.booking_date >= ${start.toISOString().slice(0, 10)}::date
          AND bk.booking_date <  ${end.toISOString().slice(0, 10)}::date
      )
    ORDER BY a.name
  `);
  return rows.map((r) => r.name);
}
