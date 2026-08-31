import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { parseDateOnly } from "@/lib/dates";

/**
 * Paginated, filterable listings for the Batches and Sales pages.
 * The sales listing computes profit in SQL for the same reason the dashboard
 * does: the client is never handed unit costs to multiply.
 */

export const PAGE_SIZE = 50;

/* ------------------------------------------------------------------- batches */

export type BatchStatusFilter = "all" | "active" | "depleted";

export type BatchListFilters = {
  productId: number | null;
  status: BatchStatusFilter;
  page: number;
};

export type BatchRow = {
  id: number;
  productName: string;
  sku: string;
  packagingType: string;
  variantValue: string;
  unit: string;
  quantity: number;
  remainingQty: number;
  soldQty: number;
  unitCost: number;
  totalCost: number;
  receivedDate: Date;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
  salesCount: number;
};

export async function getBatchList(filters: BatchListFilters): Promise<{
  rows: BatchRow[];
  total: number;
  page: number;
  pageCount: number;
}> {
  const where: Prisma.BatchWhereInput = { isDeleted: false };
  if (filters.productId != null) where.productId = filters.productId;
  if (filters.status === "active") where.remainingQty = { gt: 0 };
  if (filters.status === "depleted") where.remainingQty = { lte: 0 };

  const page = Math.max(1, filters.page);
  const [total, batches] = await Promise.all([
    prisma.batch.count({ where }),
    prisma.batch.findMany({
      where,
      orderBy: [{ receivedDate: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        product: {
          select: {
            name: true,
            sku: true,
            packagingType: true,
            variantValue: true,
            unit: true,
          },
        },
        _count: { select: { sales: true } },
      },
    }),
  ]);

  const rows = batches.map<BatchRow>((b) => {
    const unitCost = Number(b.unitCost);
    return {
      id: b.id,
      productName: b.product.name,
      sku: b.product.sku,
      packagingType: b.product.packagingType,
      variantValue: b.product.variantValue,
      unit: b.product.unit,
      quantity: b.quantity,
      remainingQty: b.remainingQty,
      soldQty: b.quantity - b.remainingQty,
      unitCost,
      totalCost: unitCost * b.quantity,
      receivedDate: b.receivedDate,
      notes: b.notes,
      createdBy: b.createdBy,
      createdAt: b.createdAt,
      salesCount: b._count.sales,
    };
  });

  return { rows, total, page, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

/* --------------------------------------------------------------------- sales */

export type SaleListFilters = {
  from: string | null;
  to: string | null;
  areaId: number | null;
  productId: number | null;
  page: number;
};

export type SaleRow = {
  id: number;
  saleDate: Date;
  sku: string;
  productName: string;
  packagingType: string;
  variantValue: string;
  batchId: number;
  quantity: number;
  salePrice: number;
  unitCost: number;
  revenue: number;
  profit: number;
  marginPct: number | null;
  areaName: string;
  shopName: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
};

function saleWhere(filters: SaleListFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`s.is_deleted = false`,
    Prisma.sql`b.is_deleted = false`,
  ];
  if (filters.from) parts.push(Prisma.sql`s.sale_date >= ${filters.from}::date`);
  if (filters.to) parts.push(Prisma.sql`s.sale_date <= ${filters.to}::date`);
  if (filters.areaId != null) parts.push(Prisma.sql`s.area_id = ${filters.areaId}`);
  if (filters.productId != null) parts.push(Prisma.sql`s.product_id = ${filters.productId}`);
  return Prisma.sql`WHERE ${Prisma.join(parts, " AND ")}`;
}

export async function getSaleList(filters: SaleListFilters): Promise<{
  rows: SaleRow[];
  total: number;
  page: number;
  pageCount: number;
  totals: { revenue: number; profit: number; units: number };
}> {
  // Reject malformed date filters rather than letting them reach the query.
  for (const value of [filters.from, filters.to]) {
    if (value) parseDateOnly(value);
  }

  const page = Math.max(1, filters.page);
  const offset = (page - 1) * PAGE_SIZE;
  const clause = saleWhere(filters);

  const [rows, summary] = await Promise.all([
    prisma.$queryRaw<
      (Omit<SaleRow, "saleDate" | "createdAt"> & { saleDate: Date; createdAt: Date })[]
    >(Prisma.sql`
      SELECT
        s.id                                          AS "id",
        s.sale_date                                   AS "saleDate",
        p.sku                                         AS "sku",
        p.name                                        AS "productName",
        p.packaging_type                              AS "packagingType",
        p.variant_value                               AS "variantValue",
        s.batch_id                                    AS "batchId",
        s.quantity                                    AS "quantity",
        s.sale_price::float8                          AS "salePrice",
        b.unit_cost::float8                           AS "unitCost",
        (s.sale_price * s.quantity)::float8           AS "revenue",
        ((s.sale_price - b.unit_cost) * s.quantity)::float8 AS "profit",
        CASE WHEN s.sale_price > 0
             THEN ((s.sale_price - b.unit_cost) / s.sale_price * 100)::float8
             END                                      AS "marginPct",
        a.name                                        AS "areaName",
        sh.name                                       AS "shopName",
        s.notes                                       AS "notes",
        s.created_by                                  AS "createdBy",
        s.created_at                                  AS "createdAt"
      FROM sales s
      JOIN batches b   ON b.id = s.batch_id
      JOIN products p  ON p.id = s.product_id
      JOIN areas a     ON a.id = s.area_id
      LEFT JOIN shops sh ON sh.id = s.shop_id
      ${clause}
      ORDER BY s.sale_date DESC, s.id DESC
      LIMIT ${PAGE_SIZE} OFFSET ${offset}
    `),
    prisma.$queryRaw<{ total: number; revenue: number; profit: number; units: number }[]>(
      Prisma.sql`
        SELECT
          COUNT(*)::int                                                  AS total,
          COALESCE(SUM(s.sale_price * s.quantity), 0)::float8            AS revenue,
          COALESCE(SUM((s.sale_price - b.unit_cost) * s.quantity), 0)::float8 AS profit,
          COALESCE(SUM(s.quantity), 0)::int                              AS units
        FROM sales s
        JOIN batches b  ON b.id = s.batch_id
        JOIN products p ON p.id = s.product_id
        ${clause}
      `,
    ),
  ]);

  const agg = summary[0] ?? { total: 0, revenue: 0, profit: 0, units: 0 };
  return {
    rows,
    total: agg.total,
    page,
    pageCount: Math.max(1, Math.ceil(agg.total / PAGE_SIZE)),
    totals: { revenue: agg.revenue, profit: agg.profit, units: agg.units },
  };
}

/* --------------------------------------------------------------- audit trail */

export async function getRecentAudit(limit = 50) {
  const rows = await prisma.auditLog.findMany({
    orderBy: { id: "desc" },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id.toString(),
    entityType: r.entityType,
    entityId: r.entityId,
    action: r.action,
    actor: r.actor,
    createdAt: r.createdAt,
  }));
}
