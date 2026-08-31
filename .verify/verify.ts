/**
 * End-to-end check of the data layer against a real Postgres.
 * Run via .verify/tsconfig.verify.json so next/cache is stubbed.
 */
import { prisma } from "@/lib/db";
import { emptyActionState } from "@/lib/validations";
import { createBatchAction, softDeleteBatchAction } from "@/actions/batches";
import { createSaleAction, softDeleteSaleAction } from "@/actions/sales";
import { createAreaAction, createShop, deleteAreaAction } from "@/actions/areas";
import { createProductAction } from "@/actions/products";
import {
  getAvailableBatchesForProduct,
  getAvailableYears,
  getKpis,
  getMonthlyTrend,
  getRevenueByArea,
  getRevenueByCategory,
  getRevenueByPackaging,
  getRevenueByProductName,
  getRevenueByShop,
  getRevenueByVariant,
  getStockLevels,
  type Scope,
} from "@/lib/queries";
import { getBatchList, getSaleList } from "@/lib/lists";
import { yearRange } from "@/lib/dates";

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail?: unknown) {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}`, detail === undefined ? "" : detail);
  }
}

function section(name: string) {
  console.log(`\n=== ${name} ===`);
}

function fd(values: Record<string, string>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(values)) form.append(k, v);
  return form;
}

const YEAR = 2026;

async function main() {
  section("seed sanity");
  const productCount = await prisma.product.count();
  const skus = await prisma.product.findMany({ select: { sku: true } });
  const skuSet = new Set(skus.map((s) => s.sku));
  ok("26 products seeded", productCount === 26, productCount);
  ok("MNG-BTL-250 exists", skuSet.has("MNG-BTL-250"));
  ok("MNG-TET-500 exists", skuSet.has("MNG-TET-500"));
  ok("POM-BTL-1000 exists", skuSet.has("POM-BTL-1000"));
  ok("CHO-BAR-10 exists", skuSet.has("CHO-BAR-10"));
  const areaCount = await prisma.area.count();
  ok("4 areas seeded", areaCount === 4, areaCount);
  const shopCount = await prisma.shop.count();
  ok("7 shops seeded", shopCount === 7, shopCount);

  const mango250 = await prisma.product.findUniqueOrThrow({ where: { sku: "MNG-BTL-250" } });
  const choco = await prisma.product.findUniqueOrThrow({ where: { sku: "CHO-BAR-10" } });
  const tetra500 = await prisma.product.findUniqueOrThrow({ where: { sku: "APP-TET-500" } });
  const downtown = await prisma.area.findFirstOrThrow({ where: { name: "Downtown" } });
  const north = await prisma.area.findFirstOrThrow({ where: { name: "North Zone" } });
  const online = await prisma.area.findFirstOrThrow({ where: { name: "Online" } });
  const centralMart = await prisma.shop.findFirstOrThrow({ where: { name: "Central Mart" } });
  const northShop = await prisma.shop.findFirstOrThrow({ where: { name: "Hillview Kiosk" } });

  section("create batch");
  const r1 = await createBatchAction(
    emptyActionState,
    fd({
      productId: String(mango250.id),
      quantity: "1000",
      unitCost: "0.80",
      receivedDate: `${YEAR}-01-15`,
      notes: "First run",
      idempotencyKey: "batch-key-1",
    }),
  );
  ok("batch created", r1.ok, r1);
  const batch1 = await prisma.batch.findFirstOrThrow({
    where: { idempotencyKey: "batch-key-1" },
  });
  ok("remaining_qty starts at quantity", batch1.remainingQty === 1000, batch1.remainingQty);
  ok("received_date stored as the day given", batch1.receivedDate.toISOString().slice(0, 10) === `${YEAR}-01-15`, batch1.receivedDate.toISOString());
  ok("createdBy recorded from env", batch1.createdBy === "verify-runner", batch1.createdBy);

  section("idempotency");
  const r2 = await createBatchAction(
    emptyActionState,
    fd({
      productId: String(mango250.id),
      quantity: "1000",
      unitCost: "0.80",
      receivedDate: `${YEAR}-01-15`,
      idempotencyKey: "batch-key-1",
    }),
  );
  ok("replayed batch reports success", r2.ok, r2);
  ok(
    "replayed batch created no second row",
    (await prisma.batch.count({ where: { productId: mango250.id } })) === 1,
  );

  section("validation");
  const bad = await createBatchAction(
    emptyActionState,
    fd({ productId: String(mango250.id), quantity: "0", unitCost: "-1", receivedDate: "nope" }),
  );
  ok("zero quantity rejected", !bad.ok && !!bad.fieldErrors.quantity, bad.fieldErrors);
  ok("negative cost rejected", !!bad.fieldErrors.unitCost, bad.fieldErrors);
  ok("bad date rejected", !!bad.fieldErrors.receivedDate, bad.fieldErrors);

  // More stock, so the dashboard has something to chew on.
  const moreBatches: [number, string, number, string, string][] = [
    [mango250.id, "2026-03-02", 500, "0.85", "batch-key-2"],
    [choco.id, "2026-02-10", 5000, "0.18", "batch-key-3"],
    [tetra500.id, "2026-04-05", 800, "1.05", "batch-key-4"],
  ];
  for (const [productId, date, quantity, cost, key] of moreBatches) {
    const res = await createBatchAction(
      emptyActionState,
      fd({
        productId: String(productId),
        quantity: String(quantity),
        unitCost: cost,
        receivedDate: date,
        idempotencyKey: key,
      }),
    );
    ok(`batch ${key} created`, res.ok, res);
  }

  section("available batches for a product");
  const avail = await getAvailableBatchesForProduct(mango250.id);
  ok("two live batches for mango 250ml", avail.length === 2, avail);
  ok("oldest first (FIFO default)", avail[0].receivedDate === "2026-01-15", avail[0]);
  ok("unit cost is a plain number", typeof avail[0].unitCost === "number", typeof avail[0].unitCost);

  section("create sale + stock deduction");
  const s1 = await createSaleAction(
    emptyActionState,
    fd({
      productId: String(mango250.id),
      batchId: String(batch1.id),
      areaId: String(downtown.id),
      shopId: String(centralMart.id),
      quantity: "120",
      salePrice: "1.50",
      saleDate: `${YEAR}-01-20`,
      idempotencyKey: "sale-key-1",
    }),
  );
  ok("sale created", s1.ok, s1);
  const afterSale = await prisma.batch.findUniqueOrThrow({ where: { id: batch1.id } });
  ok("batch decremented by sale qty", afterSale.remainingQty === 880, afterSale.remainingQty);

  const s1replay = await createSaleAction(
    emptyActionState,
    fd({
      productId: String(mango250.id),
      batchId: String(batch1.id),
      areaId: String(downtown.id),
      quantity: "120",
      salePrice: "1.50",
      saleDate: `${YEAR}-01-20`,
      idempotencyKey: "sale-key-1",
    }),
  );
  ok("replayed sale reports success", s1replay.ok, s1replay);
  const afterReplay = await prisma.batch.findUniqueOrThrow({ where: { id: batch1.id } });
  ok("replayed sale did not deduct twice", afterReplay.remainingQty === 880, afterReplay.remainingQty);

  section("oversell guards");
  const over = await createSaleAction(
    emptyActionState,
    fd({
      productId: String(mango250.id),
      batchId: String(batch1.id),
      areaId: String(downtown.id),
      quantity: "99999",
      salePrice: "1.50",
      saleDate: `${YEAR}-01-21`,
      idempotencyKey: "sale-oversell",
    }),
  );
  ok("oversell rejected", !over.ok, over);
  ok("oversell message names the remaining qty", (over.message ?? "").includes("880"), over.message);

  const wrongBatch = await createSaleAction(
    emptyActionState,
    fd({
      productId: String(choco.id),
      batchId: String(batch1.id),
      areaId: String(downtown.id),
      quantity: "1",
      salePrice: "0.50",
      saleDate: `${YEAR}-01-21`,
      idempotencyKey: "sale-wrong-batch",
    }),
  );
  ok("batch/product mismatch rejected", !wrongBatch.ok, wrongBatch);

  const wrongShop = await createSaleAction(
    emptyActionState,
    fd({
      productId: String(mango250.id),
      batchId: String(batch1.id),
      areaId: String(downtown.id),
      shopId: String(northShop.id),
      quantity: "1",
      salePrice: "1.50",
      saleDate: `${YEAR}-01-21`,
      idempotencyKey: "sale-wrong-shop",
    }),
  );
  ok("shop outside the selected area rejected", !wrongShop.ok, wrongShop);

  // The database-level CHECK constraints are probed separately, in
  // .verify/pglite-run.mjs, straight against PGlite - a deliberate server-side
  // error kills the test socket that Prisma is talking over.

  // A spread of sales across areas, shops, months and categories.
  const sales: [number, number, number, number | null, number, string, string, string][] = [
    [mango250.id, batch1.id, downtown.id, centralMart.id, 200, "1.60", `${YEAR}-02-14`, "s2"],
    [mango250.id, batch1.id, north.id, northShop.id, 150, "1.45", `${YEAR}-03-08`, "s3"],
    [mango250.id, batch1.id, online.id, null, 300, "1.75", `${YEAR}-05-19`, "s4"],
    [choco.id, 0, downtown.id, centralMart.id, 2000, "0.50", `${YEAR}-02-20`, "s5"],
    [choco.id, 0, north.id, null, 1200, "0.45", `${YEAR}-06-11`, "s6"],
    [tetra500.id, 0, online.id, null, 400, "2.10", `${YEAR}-07-01`, "s7"],
    [tetra500.id, 0, downtown.id, centralMart.id, 250, "1.95", `${YEAR}-11-23`, "s8"],
  ];
  section("more sales across areas / months / categories");
  for (const [productId, rawBatchId, areaId, shopId, quantity, price, date, key] of sales) {
    let batchId = rawBatchId;
    if (batchId === 0) {
      const options = await getAvailableBatchesForProduct(productId);
      batchId = options[0].id;
    }
    const res = await createSaleAction(
      emptyActionState,
      fd({
        productId: String(productId),
        batchId: String(batchId),
        areaId: String(areaId),
        ...(shopId != null ? { shopId: String(shopId) } : {}),
        quantity: String(quantity),
        salePrice: price,
        saleDate: date,
        idempotencyKey: key,
      }),
    );
    ok(`sale ${key} created`, res.ok, res);
  }

  section("dashboard aggregates");
  const filters = { year: YEAR, categoryId: null, areaId: null };
  const scope: Scope = { ...yearRange(YEAR), categoryId: null, areaId: null };

  const kpis = await getKpis(filters);
  // Hand-computed expectation for the year:
  //   mango b1 @0.80: 120*1.50 + 200*1.60 + 150*1.45 + 300*1.75 = 180+320+217.5+525 = 1242.5
  //   choco b3 @0.18: 2000*0.50 + 1200*0.45 = 1000 + 540 = 1540
  //   apple b4 @1.05: 400*2.10 + 250*1.95 = 840 + 487.5 = 1327.5
  const expectedRevenue = 1242.5 + 1540 + 1327.5;
  //   mango profit: 770*(price-0.80) per line -> 120*.70 + 200*.80 + 150*.65 + 300*.95 = 84+160+97.5+285 = 626.5
  //   choco profit: 2000*.32 + 1200*.27 = 640 + 324 = 964
  //   apple profit: 400*1.05 + 250*0.90 = 420 + 225 = 645
  const expectedProfit = 626.5 + 964 + 645;
  ok(
    `year revenue = ${expectedRevenue}`,
    Math.abs(kpis.year.revenue - expectedRevenue) < 0.005,
    kpis.year.revenue,
  );
  ok(
    `year profit = ${expectedProfit}`,
    Math.abs(kpis.year.profit - expectedProfit) < 0.005,
    kpis.year.profit,
  );
  ok("year units = 4620", kpis.year.units === 4620, kpis.year.units);
  ok("revenue is a JS number not a Decimal", typeof kpis.year.revenue === "number");

  const trend = await getMonthlyTrend(filters);
  ok("trend has 12 points", trend.length === 12, trend.length);
  ok("trend labels are month names", trend[0].label === "Jan" && trend[11].label === "Dec");
  ok(
    "trend sums to the year total",
    Math.abs(trend.reduce((s, m) => s + m.revenue, 0) - expectedRevenue) < 0.005,
  );
  ok("January revenue = 180", Math.abs(trend[0].revenue - 180) < 0.005, trend[0]);
  ok("April is an empty filled month", trend[3].revenue === 0 && trend[3].units === 0, trend[3]);

  const packaging = await getRevenueByPackaging(scope);
  ok("packaging buckets: Bottle, Bar, Tetra Pack", packaging.length === 3, packaging);
  ok(
    "packaging sorted by revenue desc",
    packaging.every((p, i) => i === 0 || packaging[i - 1].revenue >= p.revenue),
    packaging,
  );

  const variants = await getRevenueByVariant(scope);
  ok("variant buckets present", variants.length === 3, variants);
  ok(
    "variants ordered 10g < 250ml < 500ml",
    variants.map((v) => v.label).join(",") === "10g,250ml,500ml",
    variants.map((v) => v.label),
  );

  const flavors = await getRevenueByProductName(scope);
  ok("flavor buckets include Mango Juice", flavors.some((f) => f.label === "Mango Juice"), flavors);

  const byArea = await getRevenueByArea(scope);
  ok("three areas with sales", byArea.length === 3, byArea);
  ok(
    "areas sum to the year total",
    Math.abs(byArea.reduce((s, a) => s + a.revenue, 0) - expectedRevenue) < 0.005,
  );

  const byShop = await getRevenueByShop(scope, 10);
  ok(
    "direct sales get their own bucket",
    byShop.some((s) => s.label === "Direct Sale (no shop)"),
    byShop.map((s) => s.label),
  );
  ok(
    "shops sum to the year total",
    Math.abs(byShop.reduce((s, a) => s + a.revenue, 0) - expectedRevenue) < 0.005,
  );

  const byCategory = await getRevenueByCategory(scope);
  ok("two categories", byCategory.length === 2, byCategory);
  ok(
    "chocolate revenue = 1540",
    Math.abs((byCategory.find((c) => c.label === "Chocolate")?.revenue ?? 0) - 1540) < 0.005,
    byCategory,
  );

  section("filters compose");
  const juiceCategory = await prisma.category.findFirstOrThrow({
    where: { name: "Juice & Beverage" },
  });
  const juiceOnly = await getKpis({ year: YEAR, categoryId: juiceCategory.id, areaId: null });
  ok(
    "category filter excludes chocolate",
    Math.abs(juiceOnly.year.revenue - (1242.5 + 1327.5)) < 0.005,
    juiceOnly.year.revenue,
  );
  const downtownOnly = await getKpis({ year: YEAR, categoryId: null, areaId: downtown.id });
  // downtown: 180 + 320 + 1000 + 487.5
  ok(
    "area filter narrows to Downtown",
    Math.abs(downtownOnly.year.revenue - 1987.5) < 0.005,
    downtownOnly.year.revenue,
  );
  const both = await getKpis({ year: YEAR, categoryId: juiceCategory.id, areaId: downtown.id });
  ok("category + area compose", Math.abs(both.year.revenue - 987.5) < 0.005, both.year.revenue);
  const otherYear = await getKpis({ year: YEAR - 1, categoryId: null, areaId: null });
  ok("past year is empty", otherYear.year.revenue === 0, otherYear.year);
  ok("past year suppresses the Today card", otherYear.today.units === 0 && !otherYear.isCurrentYear);

  section("stock levels");
  const stock = await getStockLevels();
  ok("one row per product", stock.length === 26, stock.length);
  const mangoStock = stock.find((s) => s.sku === "MNG-BTL-250")!;
  //  batch1 1000 - 770 sold = 230, plus batch2 500 untouched = 730
  ok("mango 250ml stock = 730", mangoStock.currentStock === 730, mangoStock.currentStock);
  ok("mango has 2 live batches", mangoStock.batchCount === 2, mangoStock.batchCount);
  ok(
    "weighted avg cost between 0.80 and 0.85",
    mangoStock.avgUnitCost !== null &&
      mangoStock.avgUnitCost > 0.8 &&
      mangoStock.avgUnitCost < 0.85,
    mangoStock.avgUnitCost,
  );
  const untouched = stock.find((s) => s.sku === "PCH-BTL-500")!;
  ok("never-stocked product reads zero, not null", untouched.currentStock === 0, untouched);
  ok("never-stocked product has null avg cost", untouched.avgUnitCost === null, untouched);

  section("listings");
  const batchList = await getBatchList({ productId: null, status: "all", page: 1 });
  ok("4 batches listed", batchList.total === 4, batchList.total);
  const activeOnly = await getBatchList({ productId: null, status: "active", page: 1 });
  ok("all 4 batches still active", activeOnly.total === 4, activeOnly.total);
  const filteredBatches = await getBatchList({ productId: mango250.id, status: "all", page: 1 });
  ok("batch product filter works", filteredBatches.total === 2, filteredBatches.total);
  ok(
    "soldQty derived correctly",
    filteredBatches.rows.some((r) => r.soldQty === 770),
    filteredBatches.rows.map((r) => r.soldQty),
  );

  const saleList = await getSaleList({ from: null, to: null, areaId: null, productId: null, page: 1 });
  ok("8 sales listed", saleList.total === 8, saleList.total);
  ok(
    "listing totals match the dashboard",
    Math.abs(saleList.totals.revenue - expectedRevenue) < 0.005 &&
      Math.abs(saleList.totals.profit - expectedProfit) < 0.005,
    saleList.totals,
  );
  ok("newest sale first", saleList.rows[0].saleDate.toISOString().slice(0, 10) === `${YEAR}-11-23`, saleList.rows[0].saleDate);
  ok(
    "per-line profit computed in SQL",
    Math.abs(saleList.rows[0].profit - 250 * (1.95 - 1.05)) < 0.005,
    saleList.rows[0],
  );
  ok(
    "margin percent computed",
    saleList.rows[0].marginPct !== null && Math.abs(saleList.rows[0].marginPct! - 46.15) < 0.1,
    saleList.rows[0].marginPct,
  );
  ok(
    "direct sale shows a null shop",
    saleList.rows.some((r) => r.shopName === null),
  );

  const ranged = await getSaleList({
    from: `${YEAR}-02-01`,
    to: `${YEAR}-03-31`,
    areaId: null,
    productId: null,
    page: 1,
  });
  ok("date range filter works", ranged.total === 3, ranged.total);
  const byAreaList = await getSaleList({
    from: null,
    to: null,
    areaId: online.id,
    productId: null,
    page: 1,
  });
  ok("area filter on the listing works", byAreaList.total === 2, byAreaList.total);

  section("soft delete a sale returns stock");
  const saleToRemove = await prisma.sale.findFirstOrThrow({ where: { idempotencyKey: "s3" } });
  const before = await prisma.batch.findUniqueOrThrow({ where: { id: saleToRemove.batchId } });
  const del = await softDeleteSaleAction(emptyActionState, fd({ id: String(saleToRemove.id), reason: "typo" }));
  ok("sale soft deleted", del.ok, del);
  const after = await prisma.batch.findUniqueOrThrow({ where: { id: saleToRemove.batchId } });
  ok(
    "quantity returned to the batch",
    after.remainingQty === before.remainingQty + saleToRemove.quantity,
    { before: before.remainingQty, after: after.remainingQty },
  );
  const stillThere = await prisma.sale.findUniqueOrThrow({ where: { id: saleToRemove.id } });
  ok("row kept, only flagged", stillThere.isDeleted === true);
  const afterDelete = await getKpis(filters);
  ok(
    "deleted sale drops out of the aggregates",
    Math.abs(afterDelete.year.revenue - (expectedRevenue - 217.5)) < 0.005,
    afterDelete.year.revenue,
  );
  const listAfterDelete = await getSaleList({ from: null, to: null, areaId: null, productId: null, page: 1 });
  ok("deleted sale drops out of the listing", listAfterDelete.total === 7, listAfterDelete.total);

  section("soft delete guards");
  const batchWithSales = await softDeleteBatchAction(emptyActionState, fd({ id: String(batch1.id) }));
  ok("batch with sales cannot be removed", !batchWithSales.ok, batchWithSales);
  const areaWithSales = await deleteAreaAction(emptyActionState, fd({ id: String(downtown.id) }));
  ok("area with sales cannot be removed", !areaWithSales.ok, areaWithSales);

  const emptyBatchRes = await createBatchAction(
    emptyActionState,
    fd({
      productId: String(mango250.id),
      quantity: "10",
      unitCost: "0.90",
      receivedDate: `${YEAR}-08-01`,
      idempotencyKey: "batch-to-delete",
    }),
  );
  ok("throwaway batch created", emptyBatchRes.ok, emptyBatchRes);
  const throwaway = await prisma.batch.findFirstOrThrow({
    where: { idempotencyKey: "batch-to-delete" },
  });
  const delBatch = await softDeleteBatchAction(emptyActionState, fd({ id: String(throwaway.id) }));
  ok("batch with no sales can be removed", delBatch.ok, delBatch);
  const stockAfterBatchDelete = await getStockLevels();
  ok(
    "deleted batch stops counting as stock",
    stockAfterBatchDelete.find((s) => s.sku === "MNG-BTL-250")!.currentStock === 730 + 150,
    stockAfterBatchDelete.find((s) => s.sku === "MNG-BTL-250")!.currentStock,
  );

  section("areas and shops");
  const newArea = await createAreaAction(emptyActionState, fd({ name: "West Zone" }));
  ok("area created", newArea.ok, newArea);
  const dupArea = await createAreaAction(emptyActionState, fd({ name: "West Zone" }));
  ok("duplicate area rejected", !dupArea.ok, dupArea);
  const westZone = await prisma.area.findFirstOrThrow({ where: { name: "West Zone" } });
  const shopRes = await createShop({ areaId: westZone.id, name: "Westside Store" });
  ok("shop created on the fly", shopRes.ok, shopRes);
  const shopAgain = await createShop({ areaId: westZone.id, name: "Westside Store" });
  ok(
    "re-adding the same shop is idempotent",
    shopAgain.ok && shopRes.ok && shopAgain.shopId === shopRes.shopId,
    { shopAgain, shopRes },
  );
  const emptyAreaDelete = await deleteAreaAction(emptyActionState, fd({ id: String(westZone.id) }));
  ok("area with no sales can be removed", emptyAreaDelete.ok, emptyAreaDelete);
  const westShops = await prisma.shop.findMany({ where: { areaId: westZone.id } });
  ok("removing an area hides its shops", westShops.every((s) => s.isDeleted), westShops);

  section("catalog additions");
  const newProduct = await createProductAction(
    emptyActionState,
    fd({
      categoryId: String((await prisma.category.findFirstOrThrow({ where: { name: "Chocolate" } })).id),
      name: "Chocolate",
      packagingType: "Bar",
      variantValue: "20g",
      unit: "bar",
      defaultSalePrice: "0.90",
    }),
  );
  ok("new chocolate size added", newProduct.ok, newProduct);
  ok("SKU auto-generated as CHO-BAR-20", (newProduct.message ?? "").includes("CHO-BAR-20"), newProduct.message);

  section("year dropdown");
  const years = await getAvailableYears();
  ok("years include 2026", years.includes(2026), years);
  ok("years include the current year", years.includes(new Date().getFullYear()), years);
  ok("years sorted descending", years.every((y, i) => i === 0 || years[i - 1] > y), years);

  section("audit trail");
  const auditCount = await prisma.auditLog.count();
  ok("audit rows written", auditCount > 15, auditCount);
  const saleAudit = await prisma.auditLog.findFirst({
    where: { entityType: "sale", action: "sale.created" },
  });
  ok("sale audit records the actor", saleAudit?.actor === "verify-runner", saleAudit?.actor);
  ok("sale audit carries a payload", saleAudit?.payload != null, saleAudit?.payload);
  const deleteAudit = await prisma.auditLog.findFirst({
    where: { entityType: "sale", action: "sale.soft_deleted" },
  });
  ok("soft delete audited", deleteAudit != null);

  // Last, on purpose: this one provokes a real unique-violation from Postgres,
  // which permanently closes the PGlite test socket.
  section("duplicate catalog entry");
  const dupProduct = await createProductAction(
    emptyActionState,
    fd({
      categoryId: String((await prisma.category.findFirstOrThrow({ where: { name: "Chocolate" } })).id),
      name: "Chocolate",
      packagingType: "Bar",
      variantValue: "20g",
      unit: "bar",
      defaultSalePrice: "0.90",
    }),
  );
  ok("duplicate product identity rejected", !dupProduct.ok, dupProduct);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.error(`${failures} FAILED`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
