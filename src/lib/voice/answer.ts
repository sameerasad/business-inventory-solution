/**
 * What the app says back.
 *
 * Answers reuse the same queries the pages use, so a spoken figure and the
 * figure on screen can never disagree. Revenue and profit stay on the cash
 * basis - the app recognises money when it arrives, and a voice answer that
 * quietly used a different basis would be worse than no answer.
 */

import { prisma } from "@/lib/db";
import { currentYear } from "@/lib/dates";
import { money, qty } from "@/lib/format";
import { getCashKpis } from "@/lib/recognition";
import { getReceivables } from "@/lib/bookings";
import { getStockLevels } from "@/lib/queries";
import type { QueryPeriod } from "@/lib/voice/lexicon";
import type { VoiceCommand } from "@/lib/voice/parse";

type Question = Extract<VoiceCommand, { kind: "query" }>;

export type VoiceAnswer = {
  /** A whole sentence, meant to be read aloud. */
  speech: string;
  /** The figure on its own, for the panel. */
  value: string;
  label: string;
  /** Where to go to see the detail behind it. */
  href: string;
};

const PERIOD_LABEL: Record<QueryPeriod, string> = {
  today: "today",
  month: "this month",
  year: "this year",
};

export async function answerQuery(question: Question): Promise<VoiceAnswer> {
  const { metric, period } = question;

  // "Corner Store ka balance kitna hai" - one shop, not the whole book.
  if (metric === "balance") {
    return answerBalance(question);
  }

  if (metric === "orders") {
    const { start, end } = periodRange(period);
    const rows = await prisma.$queryRaw<{ orders: number; value: number }[]>`
      SELECT
        COUNT(DISTINCT b.id)::int         AS "orders",
        COALESCE(SUM(t.total), 0)::float8 AS "value"
      FROM bookings b
      LEFT JOIN (
        SELECT s.booking_id, SUM(s.sale_price * s.quantity) AS total
        FROM sales s
        JOIN batches ba ON ba.id = s.batch_id
        WHERE s.is_deleted = false AND ba.is_deleted = false AND s.booking_id IS NOT NULL
        GROUP BY s.booking_id
      ) t ON t.booking_id = b.id
      WHERE b.is_deleted = false
        AND b.booking_date >= ${start}::date
        AND b.booking_date < ${end}::date
    `;
    const row = rows[0] ?? { orders: 0, value: 0 };
    return {
      speech:
        row.orders === 0
          ? `No orders were booked ${PERIOD_LABEL[period]}.`
          : `${qty(row.orders)} orders ${PERIOD_LABEL[period]}, worth ${money(row.value)}.`,
      value: qty(row.orders),
      label: `Orders ${PERIOD_LABEL[period]}`,
      href: "/bookings",
    };
  }

  if (metric === "stock" && question.productId != null) {
    const rows = await getStockLevels();
    const row = rows.find((r) => r.productId === question.productId);
    const units = row?.currentStock ?? 0;
    const name = question.productLabel ?? row?.sku ?? "that product";
    return {
      speech:
        units === 0 ? `${name} is out of stock.` : `${qty(units)} units of ${name} are in stock.`,
      value: qty(units),
      label: name,
      href: "/products",
    };
  }

  if (metric === "outstanding" || metric === "collected") {
    // Receivables is a position, not a period: what is owed is owed today.
    const receivables = await getReceivables({ areaId: null });
    const isOutstanding = metric === "outstanding";
    const value = isOutstanding ? receivables.totals.outstanding : receivables.totals.collected;
    const label = isOutstanding ? "Outstanding" : "Collected";
    return {
      speech: isOutstanding
        ? `${money(value)} is still outstanding across ${qty(receivables.rows.length)} invoices.`
        : `${money(value)} has been collected in total.`,
      value: money(value),
      label,
      href: "/receivables",
    };
  }

  if (metric === "stock") {
    const rows = await getStockLevels();
    const units = rows.reduce((sum, r) => sum + r.currentStock, 0);
    const empty = rows.filter((r) => r.isActive && r.currentStock === 0).length;
    return {
      speech:
        empty > 0
          ? `${qty(units)} units in stock, and ${qty(empty)} active products have run out.`
          : `${qty(units)} units in stock across every product.`,
      value: qty(units),
      label: "Units in stock",
      href: "/products",
    };
  }

  const kpis = await getCashKpis({
    year: currentYear(),
    categoryId: null,
    areaId: null,
    bookerId: null,
  });
  const bucket = period === "today" ? kpis.today : period === "month" ? kpis.month : kpis.year;

  if (metric === "units") {
    return {
      speech: `${qty(bucket.units)} units were delivered ${PERIOD_LABEL[period]}.`,
      value: qty(bucket.units),
      label: `Units delivered ${PERIOD_LABEL[period]}`,
      href: "/sales",
    };
  }

  const isProfit = metric === "profit";
  const value = isProfit ? bucket.profit : bucket.revenue;
  return {
    speech: `${isProfit ? "Profit" : "Revenue"} ${PERIOD_LABEL[period]} is ${money(value)}.`,
    value: money(value),
    label: `${isProfit ? "Profit" : "Revenue"} ${PERIOD_LABEL[period]}`,
    href: "/dashboard",
  };
}

/** The date window a spoken period refers to, as day strings. */
function periodRange(period: QueryPeriod): { start: string; end: string } {
  const now = new Date();
  const year = now.getUTCFullYear();
  if (period === "today") {
    const start = new Date(Date.UTC(year, now.getUTCMonth(), now.getUTCDate()));
    const end = new Date(Date.UTC(year, now.getUTCMonth(), now.getUTCDate() + 1));
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  if (period === "month") {
    const start = new Date(Date.UTC(year, now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(year, now.getUTCMonth() + 1, 1));
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  return { start: `${year}-01-01`, end: `${year + 1}-01-01` };
}

/**
 * What one shop or one invoice still owes.
 *
 * A shop is summed across all its open invoices, because that is the figure you
 * ask a shopkeeper for. An invoice is answered on its own.
 */
async function answerBalance(question: Question): Promise<VoiceAnswer> {
  if (question.bookingId != null) {
    const rows = await prisma.$queryRaw<{ invoiceNo: string; balance: number }[]>`
      SELECT
        b.invoice_no                                           AS "invoiceNo",
        (COALESCE(t.total, 0) - COALESCE(pay.paid, 0))::float8  AS "balance"
      FROM bookings b
      LEFT JOIN (
        SELECT s.booking_id, SUM(s.sale_price * s.quantity) AS total
        FROM sales s
        JOIN batches ba ON ba.id = s.batch_id
        WHERE s.is_deleted = false AND ba.is_deleted = false
        GROUP BY s.booking_id
      ) t ON t.booking_id = b.id
      LEFT JOIN (
        SELECT p.booking_id, SUM(p.amount) AS paid
        FROM payments p WHERE p.is_deleted = false
        GROUP BY p.booking_id
      ) pay ON pay.booking_id = b.id
      WHERE b.id = ${question.bookingId}
    `;
    const row = rows[0];
    return {
      speech: row
        ? `${row.invoiceNo} has ${money(row.balance)} outstanding.`
        : "That invoice could not be found.",
      value: money(row?.balance ?? 0),
      label: row?.invoiceNo ?? "Invoice",
      href: "/receivables",
    };
  }

  const rows = await prisma.$queryRaw<{ name: string; balance: number; invoices: number }[]>`
    SELECT
      sh.name                                                        AS "name",
      COALESCE(SUM(GREATEST(0, COALESCE(t.total, 0) - COALESCE(pay.paid, 0))), 0)::float8 AS "balance",
      COUNT(*) FILTER (
        WHERE COALESCE(t.total, 0) - COALESCE(pay.paid, 0) > 0.005
      )::int                                                         AS "invoices"
    FROM bookings b
    JOIN shops sh ON sh.id = b.shop_id
    LEFT JOIN (
      SELECT s.booking_id, SUM(s.sale_price * s.quantity) AS total
      FROM sales s
      JOIN batches ba ON ba.id = s.batch_id
      WHERE s.is_deleted = false AND ba.is_deleted = false
      GROUP BY s.booking_id
    ) t ON t.booking_id = b.id
    LEFT JOIN (
      SELECT p.booking_id, SUM(p.amount) AS paid
      FROM payments p WHERE p.is_deleted = false
      GROUP BY p.booking_id
    ) pay ON pay.booking_id = b.id
    WHERE b.is_deleted = false AND sh.id = ${question.shopId}
    GROUP BY sh.name
  `;
  const row = rows[0];
  return {
    speech: row
      ? row.balance < 0.005
        ? `${row.name} owes nothing.`
        : `${row.name} owes ${money(row.balance)} across ${qty(row.invoices)} invoices.`
      : "Nothing has been booked to that shop yet.",
    value: money(row?.balance ?? 0),
    label: row?.name ?? question.subjectLabel ?? "Balance",
    href: "/receivables",
  };
}

/**
 * Everything the parser needs to recognise a name.
 *
 * Sent to the parser rather than queried inside it, so the parser stays pure
 * and every phrasing can be tested against a fixed catalog.
 */
export async function getVoiceCatalog() {
  const [products, areas, shops, bookers, invoices] = await Promise.all([
    prisma.$queryRaw<
      {
        id: number;
        sku: string;
        name: string;
        packagingType: string;
        variantValue: string;
        defaultSalePrice: number;
        available: number;
        frontBatchId: number | null;
      }[]
    >`
      SELECT
        p.id                           AS "id",
        p.sku                          AS "sku",
        p.name                         AS "name",
        p.packaging_type               AS "packagingType",
        p.variant_value                AS "variantValue",
        p.default_sale_price::float8   AS "defaultSalePrice",
        COALESCE(SUM(b.remaining_qty), 0)::int AS "available",
        -- Oldest batch that still has stock: the FIFO front, and the batch a
        -- counter sale should come out of.
        (
          SELECT b2.id FROM batches b2
          WHERE b2.product_id = p.id AND b2.is_deleted = false AND b2.remaining_qty > 0
          ORDER BY b2.received_date ASC, b2.id ASC
          LIMIT 1
        )                                     AS "frontBatchId"
      FROM products p
      LEFT JOIN batches b ON b.product_id = p.id AND b.is_deleted = false
      WHERE p.is_active = true
      GROUP BY p.id
      ORDER BY p.name
    `,
    prisma.area.findMany({
      where: { isDeleted: false },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.shop.findMany({
      where: { isDeleted: false },
      orderBy: { name: "asc" },
      select: { id: true, name: true, areaId: true },
    }),
    prisma.booker.findMany({
      where: { isDeleted: false, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    // Only invoices with something still owed: a paid one is not what "payment
    // received" refers to, and offering it invites a double entry.
    prisma.$queryRaw<
      { id: number; invoiceNo: string; customerName: string | null; balance: number }[]
    >`
      SELECT
        b.id                                                        AS "id",
        b.invoice_no                                                AS "invoiceNo",
        COALESCE(b.customer_name, sh.name)                          AS "customerName",
        (COALESCE(t.total, 0) - COALESCE(pay.paid, 0))::float8       AS "balance"
      FROM bookings b
      LEFT JOIN shops sh ON sh.id = b.shop_id
      LEFT JOIN (
        SELECT s.booking_id, SUM(s.sale_price * s.quantity) AS total
        FROM sales s
        JOIN batches ba ON ba.id = s.batch_id
        WHERE s.is_deleted = false AND ba.is_deleted = false AND s.booking_id IS NOT NULL
        GROUP BY s.booking_id
      ) t ON t.booking_id = b.id
      LEFT JOIN (
        SELECT p.booking_id, SUM(p.amount) AS paid
        FROM payments p WHERE p.is_deleted = false
        GROUP BY p.booking_id
      ) pay ON pay.booking_id = b.id
      WHERE b.is_deleted = false
        AND (COALESCE(t.total, 0) - COALESCE(pay.paid, 0)) > 0.005
      ORDER BY b.booking_date DESC
      LIMIT 200
    `,
  ]);

  return { products, areas, shops, bookers, invoices };
}
