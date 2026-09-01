import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { parseDateOnly } from "@/lib/dates";

export const BOOKINGS_PAGE_SIZE = 50;

/* ------------------------------------------------------------------ listing */

export type BookingListFilters = {
  from: string | null;
  to: string | null;
  areaId: number | null;
  q: string | null;
  page: number;
};

export type BookingRow = {
  id: number;
  invoiceNo: string;
  customerName: string | null;
  customerPhone: string | null;
  bookingDate: Date;
  areaName: string;
  shopName: string | null;
  shopPhone: string | null;
  shareToken: string | null;
  lineCount: number;
  units: number;
  total: number;
  profit: number;
  paid: number;
  balance: number;
  createdBy: string;
  isDeleted: boolean;
};

function bookingWhere(filters: BookingListFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`b.is_deleted = false`];
  if (filters.from) parts.push(Prisma.sql`b.booking_date >= ${filters.from}::date`);
  if (filters.to) parts.push(Prisma.sql`b.booking_date <= ${filters.to}::date`);
  if (filters.areaId != null) parts.push(Prisma.sql`b.area_id = ${filters.areaId}`);
  if (filters.q) {
    const like = `%${filters.q}%`;
    parts.push(
      Prisma.sql`(b.invoice_no ILIKE ${like} OR COALESCE(b.customer_name, '') ILIKE ${like})`,
    );
  }
  return Prisma.sql`WHERE ${Prisma.join(parts, " AND ")}`;
}

/**
 * Totals per booking come from the sales it produced, not from anything stored
 * on the booking. So an invoice total, the bookings list and the dashboard can
 * never disagree - they are all reading the same rows.
 */
export async function getBookingList(filters: BookingListFilters): Promise<{
  rows: BookingRow[];
  total: number;
  page: number;
  pageCount: number;
  totals: { revenue: number; profit: number; units: number; collected: number };
}> {
  for (const value of [filters.from, filters.to]) if (value) parseDateOnly(value);

  const page = Math.max(1, filters.page);
  const offset = (page - 1) * BOOKINGS_PAGE_SIZE;
  const clause = bookingWhere(filters);

  const [rows, summary] = await Promise.all([
    prisma.$queryRaw<BookingRow[]>(Prisma.sql`
      SELECT
        b.id                                       AS "id",
        b.invoice_no                               AS "invoiceNo",
        b.customer_name                            AS "customerName",
        b.customer_phone                           AS "customerPhone",
        b.share_token                              AS "shareToken",
        b.booking_date                             AS "bookingDate",
        a.name                                     AS "areaName",
        sh.name                                    AS "shopName",
        sh.phone                                   AS "shopPhone",
        COALESCE(agg.line_count, 0)::int           AS "lineCount",
        COALESCE(agg.units, 0)::int                AS "units",
        COALESCE(agg.total, 0)::float8             AS "total",
        COALESCE(agg.profit, 0)::float8            AS "profit",
        COALESCE(pay.paid, 0)::float8              AS "paid",
        (COALESCE(agg.total, 0) - COALESCE(pay.paid, 0))::float8 AS "balance",
        b.created_by                               AS "createdBy",
        b.is_deleted                               AS "isDeleted"
      FROM bookings b
      JOIN areas a ON a.id = b.area_id
      LEFT JOIN shops sh ON sh.id = b.shop_id
      LEFT JOIN (
        SELECT
          s.booking_id,
          -- One invoice line is (product, price); a line split across batches
          -- must still count as one line.
          COUNT(DISTINCT (s.product_id, s.sale_price))     AS line_count,
          SUM(s.quantity)                                  AS units,
          SUM(s.sale_price * s.quantity)                   AS total,
          SUM((s.sale_price - bt.unit_cost) * s.quantity)   AS profit
        FROM sales s
        JOIN batches bt ON bt.id = s.batch_id
        WHERE s.is_deleted = false AND bt.is_deleted = false AND s.booking_id IS NOT NULL
        GROUP BY s.booking_id
      ) agg ON agg.booking_id = b.id
      LEFT JOIN (
        SELECT p.booking_id, SUM(p.amount) AS paid
        FROM payments p
        WHERE p.is_deleted = false
        GROUP BY p.booking_id
      ) pay ON pay.booking_id = b.id
      ${clause}
      ORDER BY b.booking_date DESC, b.id DESC
      LIMIT ${BOOKINGS_PAGE_SIZE} OFFSET ${offset}
    `),
    prisma.$queryRaw<
      { total: number; revenue: number; profit: number; units: number; collected: number }[]
    >(
      Prisma.sql`
        SELECT
          COUNT(*)::int AS total,
          COALESCE(SUM(t.revenue), 0)::float8 AS revenue,
          COALESCE(SUM(t.profit), 0)::float8  AS profit,
          COALESCE(SUM(t.units), 0)::int      AS units,
          COALESCE(SUM(pay.paid), 0)::float8  AS collected
        FROM bookings b
        LEFT JOIN (
          SELECT
            s.booking_id,
            SUM(s.sale_price * s.quantity)                 AS revenue,
            SUM((s.sale_price - bt.unit_cost) * s.quantity) AS profit,
            SUM(s.quantity)                                AS units
          FROM sales s
          JOIN batches bt ON bt.id = s.batch_id
          WHERE s.is_deleted = false AND bt.is_deleted = false AND s.booking_id IS NOT NULL
          GROUP BY s.booking_id
        ) t ON t.booking_id = b.id
        LEFT JOIN (
          SELECT p.booking_id, SUM(p.amount) AS paid
          FROM payments p WHERE p.is_deleted = false
          GROUP BY p.booking_id
        ) pay ON pay.booking_id = b.id
        ${clause}
      `,
    ),
  ]);

  const agg = summary[0] ?? { total: 0, revenue: 0, profit: 0, units: 0, collected: 0 };
  return {
    rows,
    total: agg.total,
    page,
    pageCount: Math.max(1, Math.ceil(agg.total / BOOKINGS_PAGE_SIZE)),
    totals: {
      revenue: agg.revenue,
      profit: agg.profit,
      units: agg.units,
      collected: agg.collected,
    },
  };
}

/* ------------------------------------------------------------------- invoice */

export type InvoiceLine = {
  sku: string;
  description: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

export type Invoice = {
  id: number;
  invoiceNo: string;
  bookingDate: Date;
  createdAt: Date;
  customerName: string | null;
  customerPhone: string | null;
  areaName: string;
  shopName: string | null;
  shopAddress: string | null;
  shopPhone: string | null;
  notes: string | null;
  createdBy: string;
  isDeleted: boolean;
  lines: InvoiceLine[];
  subtotal: number;
  totalUnits: number;
  paid: number;
  balance: number;
};

/**
 * Everything the invoice needs, and nothing it must not have: no unit costs and
 * no profit. This is a customer-facing document.
 *
 * Lines are rebuilt by grouping the sales on (product, sale price), which undoes
 * the batch splitting the booker never saw.
 */
export async function getInvoice(bookingId: number): Promise<Invoice | null> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      area: { select: { name: true } },
      shop: { select: { name: true, address: true, phone: true } },
    },
  });
  if (!booking) return null;

  const lines = await prisma.$queryRaw<
    {
      sku: string;
      name: string;
      packagingType: string;
      variantValue: string;
      unit: string;
      quantity: number;
      unitPrice: number;
      lineTotal: number;
    }[]
  >(Prisma.sql`
    SELECT
      p.sku                                  AS "sku",
      p.name                                 AS "name",
      p.packaging_type                       AS "packagingType",
      p.variant_value                        AS "variantValue",
      p.unit                                 AS "unit",
      SUM(s.quantity)::int                   AS "quantity",
      s.sale_price::float8                   AS "unitPrice",
      (s.sale_price * SUM(s.quantity))::float8 AS "lineTotal"
    FROM sales s
    JOIN products p ON p.id = s.product_id
    WHERE s.booking_id = ${bookingId} AND s.is_deleted = false
    GROUP BY p.sku, p.name, p.packaging_type, p.variant_value, p.unit, s.sale_price
    ORDER BY p.name, p.packaging_type, p.variant_value
  `);

  // Payments received against this booking, for the Paid / Balance Due block.
  const paidRows = await prisma.$queryRaw<{ paid: number }[]>(Prisma.sql`
    SELECT COALESCE(SUM(p.amount), 0)::float8 AS paid
    FROM payments p
    WHERE p.booking_id = ${bookingId} AND p.is_deleted = false
  `);
  const paid = paidRows[0]?.paid ?? 0;

  const invoiceLines = lines.map<InvoiceLine>((l) => ({
    sku: l.sku,
    description: `${l.name} - ${l.packagingType} ${l.variantValue}`,
    unit: l.unit,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    lineTotal: l.lineTotal,
  }));

  const subtotal = invoiceLines.reduce((sum, l) => sum + l.lineTotal, 0);

  return {
    id: booking.id,
    invoiceNo: booking.invoiceNo,
    bookingDate: booking.bookingDate,
    createdAt: booking.createdAt,
    customerName: booking.customerName,
    customerPhone: booking.customerPhone,
    areaName: booking.area.name,
    shopName: booking.shop?.name ?? null,
    shopAddress: booking.shop?.address ?? null,
    shopPhone: booking.shop?.phone ?? null,
    notes: booking.notes,
    createdBy: booking.createdBy,
    isDeleted: booking.isDeleted,
    lines: invoiceLines,
    subtotal,
    totalUnits: invoiceLines.reduce((sum, l) => sum + l.quantity, 0),
    paid,
    // Never negative on the document, even if someone overpaid.
    balance: Math.max(0, subtotal - paid),
  };
}

/**
 * Products with how much stock is actually on hand, for the booking form. The
 * booker needs to see availability before promising a quantity.
 */
export async function getBookableProducts() {
  return prisma.$queryRaw<
    {
      id: number;
      sku: string;
      name: string;
      packagingType: string;
      variantValue: string;
      unit: string;
      categoryName: string;
      defaultSalePrice: number;
      available: number;
    }[]
  >(Prisma.sql`
    SELECT
      p.id                         AS "id",
      p.sku                        AS "sku",
      p.name                       AS "name",
      p.packaging_type             AS "packagingType",
      p.variant_value              AS "variantValue",
      p.unit                       AS "unit",
      c.name                       AS "categoryName",
      p.default_sale_price::float8 AS "defaultSalePrice",
      COALESCE(st.available, 0)::int AS "available"
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN (
      SELECT b.product_id, SUM(b.remaining_qty) AS available
      FROM batches b
      WHERE b.is_deleted = false AND b.remaining_qty > 0
      GROUP BY b.product_id
    ) st ON st.product_id = p.id
    WHERE p.is_active = true
    ORDER BY c.name, p.name, p.packaging_type, p.variant_value
  `);
}
export type BookableProduct = Awaited<ReturnType<typeof getBookableProducts>>[number];

/* ------------------------------------------------------------------ payments */

/**
 * Paid / partial / unpaid is DERIVED, never stored - the same rule as profit.
 * A stored status is a second source of truth waiting to disagree with the
 * payment rows underneath it.
 */
export type PaymentStatus = "unpaid" | "partial" | "paid";

/** Money compares to 2 decimals; anything finer is a rounding artefact. */
const CENT = 0.005;

export function paymentStatus(total: number, paid: number): PaymentStatus {
  // Nothing owed is settled, not unpaid. A zero-value order - every line at
  // price 0, or a booking whose sales have all been reversed - would otherwise
  // sit in the list claiming money is due on it.
  if (total <= CENT) return "paid";
  if (paid <= CENT) return "unpaid";
  if (paid >= total - CENT) return "paid";
  return "partial";
}

export type PaymentRow = {
  id: number;
  amount: number;
  paidOn: Date;
  method: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
};

/** Payment history for one booking, oldest first. */
export async function getPayments(bookingId: number): Promise<PaymentRow[]> {
  const rows = await prisma.payment.findMany({
    where: { bookingId, isDeleted: false },
    orderBy: [{ paidOn: "asc" }, { id: "asc" }],
    select: {
      id: true,
      amount: true,
      paidOn: true,
      method: true,
      notes: true,
      createdBy: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

/**
 * The money picture for one booking: what it is worth, what has come in, what
 * is left. Used by the payment dialog and to validate a new payment.
 */
export async function getBookingBalance(bookingId: number): Promise<{
  total: number;
  paid: number;
  balance: number;
  status: PaymentStatus;
} | null> {
  const rows = await prisma.$queryRaw<{ total: number; paid: number }[]>(Prisma.sql`
    SELECT
      COALESCE((
        SELECT SUM(s.sale_price * s.quantity)
        FROM sales s
        WHERE s.booking_id = ${bookingId} AND s.is_deleted = false
      ), 0)::float8 AS total,
      COALESCE((
        SELECT SUM(p.amount)
        FROM payments p
        WHERE p.booking_id = ${bookingId} AND p.is_deleted = false
      ), 0)::float8 AS paid
  `);
  const exists = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { id: true },
  });
  if (!exists) return null;

  const { total, paid } = rows[0] ?? { total: 0, paid: 0 };
  return {
    total,
    paid,
    balance: Math.max(0, total - paid),
    status: paymentStatus(total, paid),
  };
}

/* --------------------------------------------------------------- receivables */

export type ReceivableRow = {
  id: number;
  invoiceNo: string;
  bookingDate: Date;
  customerName: string | null;
  areaName: string;
  shopName: string | null;
  shopPhone: string | null;
  customerPhone: string | null;
  total: number;
  paid: number;
  balance: number;
  daysOutstanding: number;
};

/**
 * Everything still owed, oldest first. Aging comes from the booking date, which
 * is when the goods went out - that is the day the clock starts.
 */
export async function getReceivables(filters: { areaId: number | null } = { areaId: null }): Promise<{
  rows: ReceivableRow[];
  totals: { invoiced: number; collected: number; outstanding: number };
  buckets: { label: string; count: number; amount: number }[];
}> {
  const areaClause =
    filters.areaId != null ? Prisma.sql`AND b.area_id = ${filters.areaId}` : Prisma.empty;

  const rows = await prisma.$queryRaw<ReceivableRow[]>(Prisma.sql`
    SELECT
      b.id                                   AS "id",
      b.invoice_no                           AS "invoiceNo",
      b.booking_date                         AS "bookingDate",
      b.customer_name                        AS "customerName",
      b.customer_phone                       AS "customerPhone",
      a.name                                 AS "areaName",
      sh.name                                AS "shopName",
      sh.phone                               AS "shopPhone",
      t.total::float8                        AS "total",
      COALESCE(pay.paid, 0)::float8          AS "paid",
      (t.total - COALESCE(pay.paid, 0))::float8 AS "balance",
      (CURRENT_DATE - b.booking_date)::int   AS "daysOutstanding"
    FROM bookings b
    JOIN areas a ON a.id = b.area_id
    LEFT JOIN shops sh ON sh.id = b.shop_id
    JOIN (
      SELECT s.booking_id, SUM(s.sale_price * s.quantity) AS total
      FROM sales s
      WHERE s.is_deleted = false AND s.booking_id IS NOT NULL
      GROUP BY s.booking_id
    ) t ON t.booking_id = b.id
    LEFT JOIN (
      SELECT p.booking_id, SUM(p.amount) AS paid
      FROM payments p
      WHERE p.is_deleted = false
      GROUP BY p.booking_id
    ) pay ON pay.booking_id = b.id
    WHERE b.is_deleted = false
      ${areaClause}
      -- Only what is actually still owed, to the paisa.
      AND t.total - COALESCE(pay.paid, 0) > 0.005
    ORDER BY b.booking_date ASC, b.id ASC
  `);

  // Separate fragments per alias, rather than reusing one clause, so the column
  // it filters on always matches the table it is filtering.
  const invoicedArea =
    filters.areaId != null ? Prisma.sql`AND b2.area_id = ${filters.areaId}` : Prisma.empty;
  const collectedArea =
    filters.areaId != null ? Prisma.sql`AND b3.area_id = ${filters.areaId}` : Prisma.empty;

  const totalsRow = await prisma.$queryRaw<{ invoiced: number; collected: number }[]>(Prisma.sql`
    SELECT
      COALESCE((
        SELECT SUM(s.sale_price * s.quantity)
        FROM sales s JOIN bookings b2 ON b2.id = s.booking_id
        WHERE s.is_deleted = false AND b2.is_deleted = false ${invoicedArea}
      ), 0)::float8 AS invoiced,
      COALESCE((
        SELECT SUM(p.amount)
        FROM payments p JOIN bookings b3 ON b3.id = p.booking_id
        WHERE p.is_deleted = false AND b3.is_deleted = false ${collectedArea}
      ), 0)::float8 AS collected
  `);
  const { invoiced, collected } = totalsRow[0] ?? { invoiced: 0, collected: 0 };

  // Aging buckets, the way a collections list is normally read.
  const edges: [string, number, number][] = [
    ["0-7 days", 0, 7],
    ["8-30 days", 8, 30],
    ["31-60 days", 31, 60],
    ["60+ days", 61, Number.MAX_SAFE_INTEGER],
  ];
  const buckets = edges.map(([label, lo, hi]) => {
    const inBucket = rows.filter((r) => r.daysOutstanding >= lo && r.daysOutstanding <= hi);
    return {
      label,
      count: inBucket.length,
      amount: inBucket.reduce((sum, r) => sum + r.balance, 0),
    };
  });

  return {
    rows,
    totals: {
      invoiced,
      collected,
      outstanding: rows.reduce((sum, r) => sum + r.balance, 0),
    },
    buckets,
  };
}
