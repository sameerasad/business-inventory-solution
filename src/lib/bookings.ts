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
  totals: { revenue: number; profit: number; units: number };
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
      ${clause}
      ORDER BY b.booking_date DESC, b.id DESC
      LIMIT ${BOOKINGS_PAGE_SIZE} OFFSET ${offset}
    `),
    prisma.$queryRaw<{ total: number; revenue: number; profit: number; units: number }[]>(
      Prisma.sql`
        SELECT
          COUNT(*)::int AS total,
          COALESCE(SUM(t.revenue), 0)::float8 AS revenue,
          COALESCE(SUM(t.profit), 0)::float8  AS profit,
          COALESCE(SUM(t.units), 0)::int      AS units
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
        ${clause}
      `,
    ),
  ]);

  const agg = summary[0] ?? { total: 0, revenue: 0, profit: 0, units: 0 };
  return {
    rows,
    total: agg.total,
    page,
    pageCount: Math.max(1, Math.ceil(agg.total / BOOKINGS_PAGE_SIZE)),
    totals: { revenue: agg.revenue, profit: agg.profit, units: agg.units },
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

  const invoiceLines = lines.map<InvoiceLine>((l) => ({
    sku: l.sku,
    description: `${l.name} - ${l.packagingType} ${l.variantValue}`,
    unit: l.unit,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    lineTotal: l.lineTotal,
  }));

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
    subtotal: invoiceLines.reduce((sum, l) => sum + l.lineTotal, 0),
    totalUnits: invoiceLines.reduce((sum, l) => sum + l.quantity, 0),
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
