import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { monthRange } from "@/lib/dates";

/**
 * One booker's own month.
 *
 * Deliberately a separate query from getBookerPerformance rather than a filter
 * on it. That one carries bookedProfit, and a page that fetches margin and
 * then remembers not to render it is one careless edit away from showing a
 * booker what the stock cost. Nothing here touches the batches table at all,
 * so there is no cost figure to leak.
 */
export type MyMonth = {
  orders: number;
  /** Invoice value of the orders taken this month. */
  booked: number;
  /** Units sold. In this business a unit is a pack. */
  packs: number;
  /** Cash received against those orders, whenever it came in. */
  collected: number;
  /** Still owed on them. */
  outstanding: number;
  shops: number;
  areas: number;
};

export type MyTarget = {
  amount: number | null;
  packs: number | null;
  notes: string | null;
};

/**
 * Dates go to Postgres as YYYY-MM-DD strings cast to ::date.
 *
 * booking_date is a DATE column. Handing it a timestamp parameter lets the
 * database's own timezone shift it, which silently drops the first day of
 * every range - a bug this codebase has already paid for once.
 */
function monthBounds(year: number, month0: number): { from: string; to: string } {
  const { start, end } = monthRange(year, month0);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

export async function getMyMonth(
  bookerId: number,
  year: number,
  month0: number,
): Promise<MyMonth> {
  const { from, to } = monthBounds(year, month0);

  const rows = await prisma.$queryRaw<
    {
      orders: number;
      booked: number;
      packs: number;
      collected: number;
      shops: number;
      areas: number;
    }[]
  >(Prisma.sql`
    WITH mine AS (
      SELECT b.id, b.shop_id, b.area_id
      FROM bookings b
      WHERE b.is_deleted = false
        AND b.booker_id = ${bookerId}
        AND b.booking_date >= ${from}::date
        AND b.booking_date <  ${to}::date
    ),
    lines AS (
      SELECT
        COALESCE(SUM(s.sale_price * s.quantity), 0) AS booked,
        COALESCE(SUM(s.quantity), 0)                AS packs
      FROM sales s
      WHERE s.is_deleted = false AND s.booking_id IN (SELECT id FROM mine)
    ),
    cash AS (
      SELECT COALESCE(SUM(p.amount), 0) AS collected
      FROM payments p
      WHERE p.is_deleted = false AND p.booking_id IN (SELECT id FROM mine)
    )
    SELECT
      (SELECT COUNT(*) FROM mine)::int                                        AS "orders",
      (SELECT booked FROM lines)::float8                                      AS "booked",
      (SELECT packs FROM lines)::int                                          AS "packs",
      (SELECT collected FROM cash)::float8                                    AS "collected",
      (SELECT COUNT(DISTINCT shop_id) FROM mine WHERE shop_id IS NOT NULL)::int AS "shops",
      (SELECT COUNT(DISTINCT area_id) FROM mine)::int                         AS "areas"
  `);

  const r = rows[0] ?? { orders: 0, booked: 0, packs: 0, collected: 0, shops: 0, areas: 0 };
  return { ...r, outstanding: r.booked - r.collected };
}

export async function getMyTarget(
  bookerId: number,
  year: number,
  month0: number,
): Promise<MyTarget | null> {
  const { start } = monthRange(year, month0);
  const row = await prisma.bookerTarget.findUnique({
    where: { bookerId_month: { bookerId, month: start } },
    select: { amount: true, packs: true, notes: true },
  });
  if (!row) return null;
  return {
    amount: row.amount == null ? null : Number(row.amount),
    packs: row.packs,
    notes: row.notes,
  };
}

export type MyBookingRow = {
  id: number;
  invoiceNo: string;
  bookingDate: Date;
  customerName: string | null;
  shopName: string | null;
  areaName: string;
  packs: number;
  total: number;
  paid: number;
  balance: number;
};

/** This booker's recent orders. No cost, no margin - just what they sold. */
export async function getMyBookings(
  bookerId: number,
  year: number,
  month0: number,
  limit = 50,
): Promise<MyBookingRow[]> {
  const { from, to } = monthBounds(year, month0);

  return prisma.$queryRaw<MyBookingRow[]>(Prisma.sql`
    SELECT
      b.id                                          AS "id",
      b.invoice_no                                  AS "invoiceNo",
      b.booking_date                                AS "bookingDate",
      b.customer_name                               AS "customerName",
      sh.name                                       AS "shopName",
      a.name                                        AS "areaName",
      COALESCE(agg.packs, 0)::int                   AS "packs",
      COALESCE(agg.total, 0)::float8                AS "total",
      COALESCE(pay.paid, 0)::float8                 AS "paid",
      (COALESCE(agg.total, 0) - COALESCE(pay.paid, 0))::float8 AS "balance"
    FROM bookings b
    JOIN areas a ON a.id = b.area_id
    LEFT JOIN shops sh ON sh.id = b.shop_id
    LEFT JOIN (
      SELECT s.booking_id, SUM(s.quantity) AS packs, SUM(s.sale_price * s.quantity) AS total
      FROM sales s
      WHERE s.is_deleted = false AND s.booking_id IS NOT NULL
      GROUP BY s.booking_id
    ) agg ON agg.booking_id = b.id
    LEFT JOIN (
      SELECT p.booking_id, SUM(p.amount) AS paid
      FROM payments p WHERE p.is_deleted = false
      GROUP BY p.booking_id
    ) pay ON pay.booking_id = b.id
    WHERE b.is_deleted = false
      AND b.booker_id = ${bookerId}
      AND b.booking_date >= ${from}::date
      AND b.booking_date <  ${to}::date
    ORDER BY b.booking_date DESC, b.id DESC
    LIMIT ${limit}
  `);
}
