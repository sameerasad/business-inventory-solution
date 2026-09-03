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

/**
 * All revenue and profit numbers in the app come from this file.
 *
 * Profit is never stored. Every aggregate derives it as
 *   SUM((sale.sale_price - batch.unit_cost) * sale.quantity)
 * by joining each sale to the batch it consumed, so a correction to a batch cost
 * flows through the whole dashboard immediately.
 *
 * These are raw SQL rather than Prisma groupBy because the profit expression
 * spans two tables, which groupBy cannot express - it would force loading every
 * sale row into Node and summing in JS. Aggregating in Postgres keeps the
 * dashboard flat as the sales table grows into the hundreds of thousands.
 */

export type Money = { revenue: number; profit: number; units: number };

export type Scope = {
  /** Inclusive. */
  start: Date;
  /** Exclusive. */
  end: Date;
  categoryId: number | null;
  areaId: number | null;
};

const ZERO: Money = { revenue: 0, profit: 0, units: 0 };

/**
 * DATE columns are compared against explicit ::date literals so the server
 * timezone can never shift a day boundary.
 */
function d(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const REVENUE = Prisma.sql`COALESCE(SUM(s.sale_price * s.quantity), 0)::float8`;
const PROFIT = Prisma.sql`COALESCE(SUM((s.sale_price - b.unit_cost) * s.quantity), 0)::float8`;
const UNITS = Prisma.sql`COALESCE(SUM(s.quantity), 0)::int`;

/** sales -> batches (for unit_cost) -> products (for category/packaging/variant). */
const FROM_SALES = Prisma.sql`
  FROM sales s
  JOIN batches b ON b.id = s.batch_id
  JOIN products p ON p.id = s.product_id
`;

function where(scope: Scope): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`s.is_deleted = false`,
    Prisma.sql`b.is_deleted = false`,
    Prisma.sql`s.sale_date >= ${d(scope.start)}::date`,
    Prisma.sql`s.sale_date < ${d(scope.end)}::date`,
  ];
  if (scope.categoryId != null) parts.push(Prisma.sql`p.category_id = ${scope.categoryId}`);
  if (scope.areaId != null) parts.push(Prisma.sql`s.area_id = ${scope.areaId}`);
  return Prisma.sql`WHERE ${Prisma.join(parts, " AND ")}`;
}

type RawTotals = { revenue: number; profit: number; units: number };
type RawBucket = { bucket: string | null; revenue: number; profit: number; units: number };

/* -------------------------------------------------------------- 1. KPI totals */

async function totals(scope: Scope): Promise<Money> {
  const rows = await prisma.$queryRaw<RawTotals[]>(Prisma.sql`
    SELECT ${REVENUE} AS revenue, ${PROFIT} AS profit, ${UNITS} AS units
    ${FROM_SALES}
    ${where(scope)}
  `);
  const row = rows[0];
  return row ? { revenue: row.revenue, profit: row.profit, units: row.units } : ZERO;
}

export type Kpis = {
  today: Money;
  month: Money;
  year: Money;
  /** Today / this-month cards only mean something while viewing the live year. */
  isCurrentYear: boolean;
  monthLabel: string;
};

export async function getKpis(filters: {
  year: number;
  categoryId: number | null;
  areaId: number | null;
}): Promise<Kpis> {
  const { year, categoryId, areaId } = filters;
  const isCurrentYear = year === currentYear();
  const yr = yearRange(year);

  // For a past year, "today" and "this month" have no meaning, so the month card
  // falls back to December of that year instead of a misleading zero.
  const monthIndex0 = isCurrentYear ? currentMonthIndex0() : 11;
  const mr = monthRange(year, monthIndex0);
  const dr = dayRange(todayUtc());

  const [yearTotals, monthTotals, todayTotals] = await Promise.all([
    totals({ ...yr, categoryId, areaId }),
    totals({ ...mr, categoryId, areaId }),
    isCurrentYear ? totals({ ...dr, categoryId, areaId }) : Promise.resolve(ZERO),
  ]);

  return {
    today: todayTotals,
    month: monthTotals,
    year: yearTotals,
    isCurrentYear,
    monthLabel: `${MONTH_LABELS[monthIndex0]} ${year}`,
  };
}

/* ------------------------------------------- 2. Monthly revenue & profit trend */

export type MonthPoint = {
  month: number;
  label: string;
  revenue: number;
  profit: number;
  units: number;
};

export async function getMonthlyTrend(filters: {
  year: number;
  categoryId: number | null;
  areaId: number | null;
}): Promise<MonthPoint[]> {
  const scope: Scope = {
    ...yearRange(filters.year),
    categoryId: filters.categoryId,
    areaId: filters.areaId,
  };
  const rows = await prisma.$queryRaw<
    { month: number; revenue: number; profit: number; units: number }[]
  >(Prisma.sql`
    SELECT
      EXTRACT(MONTH FROM s.sale_date)::int AS month,
      ${REVENUE} AS revenue,
      ${PROFIT}  AS profit,
      ${UNITS}   AS units
    ${FROM_SALES}
    ${where(scope)}
    GROUP BY 1
    ORDER BY 1
  `);

  const byMonth = new Map(rows.map((r) => [r.month, r]));
  return MONTH_LABELS.map((label, i) => {
    const r = byMonth.get(i + 1);
    return {
      month: i + 1,
      label,
      revenue: r?.revenue ?? 0,
      profit: r?.profit ?? 0,
      units: r?.units ?? 0,
    };
  });
}

/* --------------------------------------------------- 3-7. Dimension breakdowns */

export type Breakdown = {
  key: string;
  label: string;
  revenue: number;
  profit: number;
  units: number;
};

async function breakdown(
  scope: Scope,
  groupExpr: Prisma.Sql,
  extraJoins?: Prisma.Sql,
  limit?: number,
): Promise<Breakdown[]> {
  const rows = await prisma.$queryRaw<RawBucket[]>(Prisma.sql`
    SELECT
      ${groupExpr} AS bucket,
      ${REVENUE} AS revenue,
      ${PROFIT}  AS profit,
      ${UNITS}   AS units
    ${FROM_SALES}
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
    units: r.units,
  }));
}

/** 4. Revenue by packaging type - Bottle vs Tetra Pack vs Bar. */
export function getRevenueByPackaging(scope: Scope) {
  return breakdown(scope, Prisma.sql`p.packaging_type`);
}

/**
 * Sort key for a volume label so the axis reads 250ml, 500ml, 1000ml rather than
 * alphabetically (1000ml, 250ml, 500ml). Grams are scaled down by 1000 so they
 * land in their own band below the millilitre sizes.
 */
function variantSortKey(label: string): number {
  const match = /^([\d.]+)\s*([a-z]*)/i.exec(label.trim());
  if (!match) return Number.MAX_SAFE_INTEGER;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  const unit = match[2].toLowerCase();
  const scale = unit === "ml" || unit === "l" ? 1 : 0.001;
  return value * (unit === "l" ? 1000 : 1) * scale;
}

/** 5. Revenue by variant / volume - 250ml, 500ml, 1000ml, 10g. */
export async function getRevenueByVariant(scope: Scope): Promise<Breakdown[]> {
  const rows = await breakdown(scope, Prisma.sql`p.variant_value`);
  // Cardinality here is the number of distinct volumes (a handful), so ordering
  // in JS costs nothing and keeps the SQL free of regex parameters.
  return rows.sort((a, b) => variantSortKey(a.label) - variantSortKey(b.label));
}

/** 6. Revenue by product name - the flavor split. */
export function getRevenueByProductName(scope: Scope) {
  return breakdown(scope, Prisma.sql`p.name`);
}

/** 7. Revenue by category - Juice & Beverage vs Chocolate. */
export function getRevenueByCategory(scope: Scope) {
  return breakdown(
    scope,
    Prisma.sql`c.name`,
    Prisma.sql`JOIN categories c ON c.id = p.category_id`,
  );
}

/** 2. Revenue and profit by area. */
export function getRevenueByArea(scope: Scope) {
  return breakdown(scope, Prisma.sql`a.name`, Prisma.sql`JOIN areas a ON a.id = s.area_id`);
}

/**
 * 3. Revenue and profit by shop, within an area or globally.
 * Direct sales (shop_id IS NULL) get their own bucket rather than being dropped,
 * so the shop chart still reconciles with the area chart.
 */
export function getRevenueByShop(scope: Scope, limit = 10) {
  return breakdown(
    scope,
    Prisma.sql`COALESCE(sh.name, ${"Direct Sale (no shop)"})`,
    Prisma.sql`LEFT JOIN shops sh ON sh.id = s.shop_id`,
    limit,
  );
}

/* ------------------------------------------------- 8. Current stock per product */

export type StockRow = {
  productId: number;
  sku: string;
  name: string;
  packagingType: string;
  variantValue: string;
  unit: string;
  categoryId: number;
  categoryName: string;
  defaultSalePrice: number;
  currentStock: number;
  batchCount: number;
  /** Weighted average cost of the stock still on hand. */
  avgUnitCost: number | null;
  isActive: boolean;
  /**
   * Every batch and live sale ever attached to this product, not just the ones
   * with stock left. Deleting a product is only allowed when both are zero, so
   * batchCount - which counts batches that still have stock - cannot answer it.
   */
  totalBatches: number;
  totalSales: number;
};

export async function getStockLevels(): Promise<StockRow[]> {
  return prisma.$queryRaw<StockRow[]>(Prisma.sql`
    SELECT
      p.id                             AS "productId",
      p.sku                            AS "sku",
      p.name                           AS "name",
      p.packaging_type                 AS "packagingType",
      p.variant_value                  AS "variantValue",
      p.unit                           AS "unit",
      p.category_id                    AS "categoryId",
      c.name                           AS "categoryName",
      p.default_sale_price::float8     AS "defaultSalePrice",
      COALESCE(st.remaining, 0)::int   AS "currentStock",
      COALESCE(st.batch_count, 0)::int AS "batchCount",
      st.avg_cost::float8              AS "avgUnitCost",
      p.is_active                      AS "isActive",
      COALESCE(hist.batches, 0)::int   AS "totalBatches",
      COALESCE(hist.sales, 0)::int     AS "totalSales"
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN (
      SELECT
        p2.id AS product_id,
        (SELECT COUNT(*) FROM batches b2 WHERE b2.product_id = p2.id)                          AS batches,
        (SELECT COUNT(*) FROM sales s2 WHERE s2.product_id = p2.id AND s2.is_deleted = false)  AS sales
      FROM products p2
    ) hist ON hist.product_id = p.id
    LEFT JOIN (
      SELECT
        b.product_id,
        SUM(b.remaining_qty)                        AS remaining,
        COUNT(*) FILTER (WHERE b.remaining_qty > 0) AS batch_count,
        CASE WHEN SUM(b.remaining_qty) > 0
             THEN SUM(b.unit_cost * b.remaining_qty) / SUM(b.remaining_qty)
             END                                    AS avg_cost
      FROM batches b
      WHERE b.is_deleted = false
      GROUP BY b.product_id
    ) st ON st.product_id = p.id
    ORDER BY c.name, p.name, p.packaging_type, p.variant_value
  `);
}

/* ------------------------------------------------------- supporting selectors */

/** Years that actually have sales or batches, for the year dropdown. */
export async function getAvailableYears(): Promise<number[]> {
  const rows = await prisma.$queryRaw<{ year: number }[]>(Prisma.sql`
    SELECT DISTINCT EXTRACT(YEAR FROM sale_date)::int AS year
      FROM sales WHERE is_deleted = false
    UNION
    SELECT DISTINCT EXTRACT(YEAR FROM received_date)::int AS year
      FROM batches WHERE is_deleted = false
  `);
  const years = new Set(rows.map((r) => r.year));
  years.add(currentYear());
  return [...years].sort((a, b) => b - a);
}

/** Flat catalog for the cascading Category > Name > Packaging > Volume pickers. */
export async function getProductOptions() {
  const products = await prisma.product.findMany({
    where: { isActive: true },
    include: { category: { select: { id: true, name: true } } },
    orderBy: [
      { categoryId: "asc" },
      { name: "asc" },
      { packagingType: "asc" },
      { variantValue: "asc" },
    ],
  });
  return products.map((p) => ({
    id: p.id,
    categoryId: p.categoryId,
    categoryName: p.category.name,
    name: p.name,
    packagingType: p.packagingType,
    variantValue: p.variantValue,
    sku: p.sku,
    unit: p.unit,
    defaultSalePrice: Number(p.defaultSalePrice),
  }));
}
export type ProductOption = Awaited<ReturnType<typeof getProductOptions>>[number];

export async function getCategories() {
  return prisma.category.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

export async function getAreasWithShops() {
  const areas = await prisma.area.findMany({
    where: { isDeleted: false },
    orderBy: { name: "asc" },
    include: {
      shops: {
        where: { isDeleted: false },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          address: true,
          phone: true,
          _count: { select: { sales: true } },
        },
      },
      _count: { select: { sales: true } },
    },
  });
  return areas.map((a) => ({
    id: a.id,
    name: a.name,
    salesCount: a._count.sales,
    shops: a.shops.map((s) => ({
      id: s.id,
      name: s.name,
      address: s.address,
      phone: s.phone,
      salesCount: s._count.sales,
    })),
  }));
}
export type AreaWithShops = Awaited<ReturnType<typeof getAreasWithShops>>[number];

/**
 * Batches still usable for a new sale: live, and with stock left.
 * Oldest received first, so the default pick drains stock FIFO. A depleted batch
 * disappears from here but stays attached to its historical sales.
 */
export async function getAvailableBatchesForProduct(productId: number) {
  const batches = await prisma.batch.findMany({
    where: { productId, isDeleted: false, remainingQty: { gt: 0 } },
    orderBy: [{ receivedDate: "asc" }, { id: "asc" }],
    select: {
      id: true,
      receivedDate: true,
      remainingQty: true,
      quantity: true,
      unitCost: true,
    },
  });
  return batches.map((b) => ({
    id: b.id,
    receivedDate: b.receivedDate.toISOString().slice(0, 10),
    remainingQty: b.remainingQty,
    quantity: b.quantity,
    unitCost: Number(b.unitCost),
  }));
}
export type AvailableBatch = Awaited<ReturnType<typeof getAvailableBatchesForProduct>>[number];
