/**
 * Editing existing records.
 *
 * The rule under test: an edit is a correction, not a second transaction. Stock
 * must stay exactly reconciled, an invoice must never end up worth less than
 * has been paid for it, and because profit is derived rather than stored,
 * correcting a cost has to re-cost every sale that came from that batch.
 */
import { prisma } from "@/lib/db";
import { emptyActionState } from "@/lib/validations";
import {
  createCategoryAction,
  deleteCategoryAction,
  renameCategoryAction,
} from "@/actions/categories";
import { createProductAction, deleteProductAction, updateProductAction } from "@/actions/products";
import { createBatchAction, updateBatchAction } from "@/actions/batches";
import { createSaleAction, updateSaleAction } from "@/actions/sales";
import {
  createBookingAction,
  updateBookingAction,
  softDeleteBookingAction,
} from "@/actions/bookings";
import { recordPaymentAction, updatePaymentAction } from "@/actions/payments";
import { createBookerAction } from "@/actions/bookers";
import { getSaleList } from "@/lib/lists";
import { getCashKpis, getCashMonthlyTrend } from "@/lib/recognition";

let checks = 0;
let failures = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  checks += 1;
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}`, detail ?? "");
  }
}
function section(n: string) {
  console.log(`\n=== ${n} ===`);
}
function fd(v: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.append(k, x);
  return f;
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

const YEAR = 2026;
const F = { year: YEAR, categoryId: null, areaId: null, bookerId: null };

/** Stock must always reconcile: sold out of a batch == sum of its live sales. */
async function stockReconciles(): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ bad: number }[]>`
    SELECT COUNT(*)::int AS bad
    FROM batches b
    LEFT JOIN (
      SELECT batch_id, SUM(quantity) AS sold
      FROM sales WHERE is_deleted = false
      GROUP BY batch_id
    ) s ON s.batch_id = b.id
    WHERE b.is_deleted = false
      AND (b.quantity - b.remaining_qty) <> COALESCE(s.sold, 0)
  `;
  return (rows[0]?.bad ?? 0) === 0;
}

async function saleRow(id: number) {
  const list = await getSaleList({
    from: null,
    to: null,
    areaId: null,
    productId: null,
    page: 1,
  });
  return list.rows.find((r) => r.id === id) ?? null;
}

async function main() {
  const mango = await prisma.product.findUniqueOrThrow({ where: { sku: "MNG-BTL-250" } });
  const downtown = await prisma.area.findFirstOrThrow({ where: { name: "Downtown" } });
  const north = await prisma.area.findFirstOrThrow({ where: { name: "North Zone" } });
  const shopA = await prisma.shop.findFirstOrThrow({ where: { name: "Central Mart" } });
  const shopNorth = await prisma.shop.findFirstOrThrow({ where: { name: "Hillview Kiosk" } });
  const juice = await prisma.category.findFirstOrThrow({ where: { name: "Juice & Beverage" } });

  // Stock for mango up front: several assertions below turn on it having
  // history, and a product with no batches and no sales is genuinely deletable.
  await createBatchAction(
    emptyActionState,
    fd({
      productId: String(mango.id),
      quantity: "100",
      unitCost: "200",
      receivedDate: `${YEAR}-01-05`,
      idempotencyKey: "ed-batch-1",
    }),
  );

  /* ------------------------------------------------------------- categories */
  section("categories");
  const madeCat = await createCategoryAction(emptyActionState, fd({ name: "Snacks" }));
  ok("category created", madeCat.ok, madeCat);
  ok(
    "duplicate refused",
    !(await createCategoryAction(emptyActionState, fd({ name: "Snacks" }))).ok,
  );
  ok("blank refused", !(await createCategoryAction(emptyActionState, fd({ name: "" }))).ok);

  const snacks = await prisma.category.findFirstOrThrow({ where: { name: "Snacks" } });
  const renamedCat = await renameCategoryAction(
    emptyActionState,
    fd({ id: String(snacks.id), name: "Snacks & Bars" }),
  );
  ok("category renamed", renamedCat.ok, renamedCat);
  ok(
    "renaming onto an existing name is refused",
    !(
      await renameCategoryAction(
        emptyActionState,
        fd({ id: String(snacks.id), name: "Juice & Beverage" }),
      )
    ).ok,
  );
  ok(
    "a category in use cannot be deleted",
    !(await deleteCategoryAction(emptyActionState, fd({ id: String(juice.id) }))).ok,
  );
  ok(
    "an empty one can",
    (await deleteCategoryAction(emptyActionState, fd({ id: String(snacks.id) }))).ok,
  );
  ok("and it is gone", (await prisma.category.count({ where: { id: snacks.id } })) === 0);

  /* --------------------------------------------------------------- products */
  section("products");
  const madeProd = await createProductAction(
    emptyActionState,
    fd({
      categoryId: String(juice.id),
      name: "Guava",
      packagingType: "Bottle",
      variantValue: "250ml",
      sku: "GUA-BTL-250",
      unit: "bottle",
      defaultSalePrice: "450",
    }),
  );
  ok("product created", madeProd.ok, madeProd);
  const guava = await prisma.product.findUniqueOrThrow({ where: { sku: "GUA-BTL-250" } });

  const editedProd = await updateProductAction(
    emptyActionState,
    fd({
      id: String(guava.id),
      categoryId: String(juice.id),
      name: "Guava Nectar",
      packagingType: "Bottle",
      variantValue: "300ml",
      sku: "GUA-BTL-300",
      unit: "bottle",
      defaultSalePrice: "500",
    }),
  );
  ok("product fully edited", editedProd.ok, editedProd);
  const guavaAfter = await prisma.product.findUniqueOrThrow({ where: { id: guava.id } });
  ok(
    "every field changed",
    guavaAfter.name === "Guava Nectar" &&
      guavaAfter.variantValue === "300ml" &&
      guavaAfter.sku === "GUA-BTL-300" &&
      Number(guavaAfter.defaultSalePrice) === 500,
    guavaAfter,
  );
  ok(
    "taking another product's SKU is refused",
    !(
      await updateProductAction(
        emptyActionState,
        fd({
          id: String(guava.id),
          categoryId: String(juice.id),
          name: "Guava Nectar",
          packagingType: "Bottle",
          variantValue: "300ml",
          sku: "MNG-BTL-250",
          unit: "bottle",
          defaultSalePrice: "500",
        }),
      )
    ).ok,
  );
  ok(
    "a blank SKU is refused on edit - it is only derived at creation",
    !(
      await updateProductAction(
        emptyActionState,
        fd({
          id: String(guava.id),
          categoryId: String(juice.id),
          name: "Guava Nectar",
          packagingType: "Bottle",
          variantValue: "300ml",
          sku: "",
          unit: "bottle",
          defaultSalePrice: "500",
        }),
      )
    ).ok,
  );
  ok(
    "an unused product can be deleted",
    (await deleteProductAction(emptyActionState, fd({ id: String(guava.id) }))).ok,
  );
  ok(
    "a product with history cannot",
    !(await deleteProductAction(emptyActionState, fd({ id: String(mango.id) }))).ok,
  );

  /* ---------------------------------------------------------------- batches */
  section("batches");
  const b1 = await prisma.batch.findFirstOrThrow({ where: { idempotencyKey: "ed-batch-1" } });

  // Sell 30 of the 100, then correct the batch.
  await createSaleAction(
    emptyActionState,
    fd({
      productId: String(mango.id),
      batchId: String(b1.id),
      areaId: String(downtown.id),
      quantity: "30",
      salePrice: "450",
      saleDate: `${YEAR}-02-01`,
      idempotencyKey: "ed-sale-1",
    }),
  );
  const s1 = await prisma.sale.findFirstOrThrow({ where: { idempotencyKey: "ed-sale-1" } });
  ok(
    "30 sold, 70 left",
    (await prisma.batch.findUniqueOrThrow({ where: { id: b1.id } })).remainingQty === 70,
  );

  const raised = await updateBatchAction(
    emptyActionState,
    fd({
      id: String(b1.id),
      quantity: "120",
      unitCost: "200",
      receivedDate: `${YEAR}-01-05`,
    }),
  );
  ok("quantity raised to 120", raised.ok, raised);
  ok(
    "remaining follows: 120 - 30 sold = 90",
    (await prisma.batch.findUniqueOrThrow({ where: { id: b1.id } })).remainingQty === 90,
  );
  ok("stock still reconciles", await stockReconciles());

  ok(
    "quantity cannot go below the 30 already sold",
    !(
      await updateBatchAction(
        emptyActionState,
        fd({ id: String(b1.id), quantity: "29", unitCost: "200", receivedDate: `${YEAR}-01-05` }),
      )
    ).ok,
  );
  const toSold = await updateBatchAction(
    emptyActionState,
    fd({ id: String(b1.id), quantity: "30", unitCost: "200", receivedDate: `${YEAR}-01-05` }),
  );
  ok("but it can go to exactly 30", toSold.ok, toSold);
  ok(
    "leaving nothing remaining",
    (await prisma.batch.findUniqueOrThrow({ where: { id: b1.id } })).remainingQty === 0,
  );
  await updateBatchAction(
    emptyActionState,
    fd({ id: String(b1.id), quantity: "120", unitCost: "200", receivedDate: `${YEAR}-01-05` }),
  );

  section("correcting a cost re-costs the sales from that batch");
  const beforeCost = await saleRow(s1.id);
  ok(
    "sale margin at cost 200: 30 x 250 = 7,500",
    near(beforeCost!.profit, 7500),
    beforeCost?.profit,
  );
  const recost = await updateBatchAction(
    emptyActionState,
    fd({ id: String(b1.id), quantity: "120", unitCost: "300", receivedDate: `${YEAR}-01-05` }),
  );
  ok("unit cost corrected to 300", recost.ok, recost);
  const afterCost = await saleRow(s1.id);
  ok(
    "the same sale now shows 30 x 150 = 4,500 - profit was never stored",
    near(afterCost!.profit, 4500),
    afterCost?.profit,
  );
  ok("and it says so in the message", (recost.message ?? "").includes("margin"), recost.message);
  await updateBatchAction(
    emptyActionState,
    fd({ id: String(b1.id), quantity: "120", unitCost: "200", receivedDate: `${YEAR}-01-05` }),
  );

  /* ------------------------------------------------------------------ sales */
  section("sales: quantity");
  const up = await updateSaleAction(
    emptyActionState,
    fd({
      id: String(s1.id),
      batchId: String(b1.id),
      areaId: String(downtown.id),
      quantity: "40",
      salePrice: "450",
      saleDate: `${YEAR}-02-01`,
    }),
  );
  ok("quantity raised 30 -> 40", up.ok, up);
  ok(
    "the batch gave up 10 more: 120 - 40 = 80",
    (await prisma.batch.findUniqueOrThrow({ where: { id: b1.id } })).remainingQty === 80,
  );
  ok("stock reconciles", await stockReconciles());

  const down = await updateSaleAction(
    emptyActionState,
    fd({
      id: String(s1.id),
      batchId: String(b1.id),
      areaId: String(downtown.id),
      quantity: "10",
      salePrice: "450",
      saleDate: `${YEAR}-02-01`,
    }),
  );
  ok("quantity lowered 40 -> 10", down.ok, down);
  ok(
    "the batch got 30 back: 120 - 10 = 110",
    (await prisma.batch.findUniqueOrThrow({ where: { id: b1.id } })).remainingQty === 110,
  );
  ok("stock reconciles", await stockReconciles());

  ok(
    "raising beyond the batch is refused",
    !(
      await updateSaleAction(
        emptyActionState,
        fd({
          id: String(s1.id),
          batchId: String(b1.id),
          areaId: String(downtown.id),
          quantity: "121",
          salePrice: "450",
          saleDate: `${YEAR}-02-01`,
        }),
      )
    ).ok,
  );
  const toFull = await updateSaleAction(
    emptyActionState,
    fd({
      id: String(s1.id),
      batchId: String(b1.id),
      areaId: String(downtown.id),
      quantity: "120",
      salePrice: "450",
      saleDate: `${YEAR}-02-01`,
    }),
  );
  ok("but the whole batch is allowed - its own 10 count as headroom", toFull.ok, toFull);
  ok(
    "batch fully drawn down",
    (await prisma.batch.findUniqueOrThrow({ where: { id: b1.id } })).remainingQty === 0,
  );

  section("sales: moving to a different batch");
  await createBatchAction(
    emptyActionState,
    fd({
      productId: String(mango.id),
      quantity: "60",
      unitCost: "150",
      receivedDate: `${YEAR}-01-20`,
      idempotencyKey: "ed-batch-2",
    }),
  );
  const b2 = await prisma.batch.findFirstOrThrow({ where: { idempotencyKey: "ed-batch-2" } });

  ok(
    "moving 120 units into a 60-unit batch is refused",
    !(
      await updateSaleAction(
        emptyActionState,
        fd({
          id: String(s1.id),
          batchId: String(b2.id),
          areaId: String(downtown.id),
          quantity: "120",
          salePrice: "450",
          saleDate: `${YEAR}-02-01`,
        }),
      )
    ).ok,
  );
  ok("nothing moved, so stock still reconciles", await stockReconciles());
  ok(
    "and the original batch is untouched",
    (await prisma.batch.findUniqueOrThrow({ where: { id: b1.id } })).remainingQty === 0,
  );

  const moved = await updateSaleAction(
    emptyActionState,
    fd({
      id: String(s1.id),
      batchId: String(b2.id),
      areaId: String(downtown.id),
      quantity: "50",
      salePrice: "450",
      saleDate: `${YEAR}-02-01`,
    }),
  );
  ok("moved to the other batch at 50 units", moved.ok, moved);
  ok(
    "the old batch is fully restored to 120",
    (await prisma.batch.findUniqueOrThrow({ where: { id: b1.id } })).remainingQty === 120,
  );
  ok(
    "the new batch is down to 10",
    (await prisma.batch.findUniqueOrThrow({ where: { id: b2.id } })).remainingQty === 10,
  );
  ok("stock reconciles", await stockReconciles());
  const movedRow = await saleRow(s1.id);
  ok(
    "and it is costed from the new batch: 50 x (450 - 150) = 15,000",
    near(movedRow!.profit, 15000),
    movedRow?.profit,
  );

  section("sales: what an edit must refuse");
  const otherProduct = await prisma.product.findUniqueOrThrow({ where: { sku: "CHO-BAR-10" } });
  await createBatchAction(
    emptyActionState,
    fd({
      productId: String(otherProduct.id),
      quantity: "10",
      unitCost: "50",
      receivedDate: `${YEAR}-01-02`,
      idempotencyKey: "ed-batch-choc",
    }),
  );
  const chocBatch = await prisma.batch.findFirstOrThrow({
    where: { idempotencyKey: "ed-batch-choc" },
  });
  ok(
    "a batch of a different product is refused",
    !(
      await updateSaleAction(
        emptyActionState,
        fd({
          id: String(s1.id),
          batchId: String(chocBatch.id),
          areaId: String(downtown.id),
          quantity: "5",
          salePrice: "450",
          saleDate: `${YEAR}-02-01`,
        }),
      )
    ).ok,
  );
  ok(
    "a shop outside the chosen area is refused",
    !(
      await updateSaleAction(
        emptyActionState,
        fd({
          id: String(s1.id),
          batchId: String(b2.id),
          areaId: String(downtown.id),
          shopId: String(shopNorth.id),
          quantity: "50",
          salePrice: "450",
          saleDate: `${YEAR}-02-01`,
        }),
      )
    ).ok,
  );
  ok("still reconciled after both refusals", await stockReconciles());

  const relocated = await updateSaleAction(
    emptyActionState,
    fd({
      id: String(s1.id),
      batchId: String(b2.id),
      areaId: String(north.id),
      shopId: String(shopNorth.id),
      quantity: "50",
      salePrice: "500",
      saleDate: `${YEAR}-04-09`,
    }),
  );
  ok("area, shop, price and date all move together", relocated.ok, relocated);
  const finalRow = await saleRow(s1.id);
  ok(
    "the row reflects every change",
    finalRow!.areaName === "North Zone" &&
      finalRow!.shopName === "Hillview Kiosk" &&
      near(finalRow!.salePrice, 500) &&
      finalRow!.saleDate.toISOString().slice(0, 10) === `${YEAR}-04-09`,
    finalRow,
  );

  /* --------------------------------------------------------------- bookings */
  section("bookings: editing the invoice details");
  await createBookerAction(emptyActionState, fd({ name: "Edit Booker" }));
  const eBooker = await prisma.booker.findFirstOrThrow({ where: { name: "Edit Booker" } });
  await createBatchAction(
    emptyActionState,
    fd({
      productId: String(mango.id),
      quantity: "200",
      unitCost: "200",
      receivedDate: `${YEAR}-01-01`,
      idempotencyKey: "ed-batch-3",
    }),
  );
  const bookingMade = await createBookingAction(
    emptyActionState,
    fd({
      customerName: "Original Name",
      areaId: String(downtown.id),
      shopId: String(shopA.id),
      bookingDate: `${YEAR}-05-01`,
      lines: JSON.stringify([{ productId: mango.id, quantity: 10, unitPrice: 500 }]),
      idempotencyKey: "ed-booking-1",
    }),
  );
  ok("booking created", bookingMade.ok, bookingMade);
  const booking = await prisma.booking.findFirstOrThrow({
    where: { idempotencyKey: "ed-booking-1" },
  });

  const bookingEdit = await updateBookingAction(
    emptyActionState,
    fd({
      id: String(booking.id),
      bookerId: String(eBooker.id),
      customerName: "Corrected Name",
      customerPhone: "0300-1234567",
      areaId: String(north.id),
      shopId: String(shopNorth.id),
      bookingDate: `${YEAR}-06-02`,
      notes: "moved",
    }),
  );
  ok("booking edited", bookingEdit.ok, bookingEdit);
  const bookingAfter = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
  ok(
    "customer, booker, area, shop and date all changed",
    bookingAfter.customerName === "Corrected Name" &&
      bookingAfter.bookerId === eBooker.id &&
      bookingAfter.areaId === north.id &&
      bookingAfter.shopId === shopNorth.id &&
      bookingAfter.bookingDate.toISOString().slice(0, 10) === `${YEAR}-06-02`,
    bookingAfter,
  );
  const lines = await prisma.sale.findMany({
    where: { bookingId: booking.id, isDeleted: false },
    select: { areaId: true, shopId: true, saleDate: true },
  });
  ok(
    "its sale lines followed the area, shop and date",
    lines.every(
      (l) =>
        l.areaId === north.id &&
        l.shopId === shopNorth.id &&
        l.saleDate.toISOString().slice(0, 10) === `${YEAR}-06-02`,
    ),
    lines,
  );
  ok(
    "a shop outside the new area is refused",
    !(
      await updateBookingAction(
        emptyActionState,
        fd({
          id: String(booking.id),
          areaId: String(north.id),
          shopId: String(shopA.id),
          bookingDate: `${YEAR}-06-02`,
        }),
      )
    ).ok,
  );

  /* --------------------------------------------------------------- payments */
  section("payments: editing what arrived, and when");
  const pay = await recordPaymentAction(
    emptyActionState,
    fd({
      bookingId: String(booking.id),
      amount: "2000",
      paidOn: `${YEAR}-06-10`,
      idempotencyKey: "ed-pay-1",
    }),
  );
  ok("payment recorded", pay.ok, pay);
  const payment = await prisma.payment.findFirstOrThrow({
    where: { idempotencyKey: "ed-pay-1" },
  });

  const junePre = await getCashMonthlyTrend(F);
  ok("2,000 recognised in June", near(junePre[5].revenue, 2000), junePre[5].revenue);

  const payEdit = await updatePaymentAction(
    emptyActionState,
    fd({
      id: String(payment.id),
      amount: "3000",
      paidOn: `${YEAR}-07-15`,
      method: "Cash",
      notes: "corrected",
    }),
  );
  ok("payment amount and date corrected", payEdit.ok, payEdit);
  const trendPost = await getCashMonthlyTrend(F);
  ok("June is now empty", near(trendPost[5].revenue, 0), trendPost[5].revenue);
  ok(
    "and the 3,000 lands in July, the month it actually arrived",
    near(trendPost[6].revenue, 3000),
    trendPost[6].revenue,
  );

  ok(
    "a payment above the invoice value is refused",
    !(
      await updatePaymentAction(
        emptyActionState,
        fd({ id: String(payment.id), amount: "999999", paidOn: `${YEAR}-07-15` }),
      )
    ).ok,
  );
  const paidToFull = await updatePaymentAction(
    emptyActionState,
    fd({ id: String(payment.id), amount: "5000", paidOn: `${YEAR}-07-15` }),
  );
  ok("but exactly the invoice value is fine", paidToFull.ok, paidToFull);
  const kpisFull = await getCashKpis(F);
  ok("all 5,000 recognised", kpisFull.year.revenue >= 5000, kpisFull.year.revenue);

  section("an edit must never undercut a payment");
  const bookingLine = await prisma.sale.findFirstOrThrow({
    where: { bookingId: booking.id, isDeleted: false },
    select: { id: true, batchId: true },
  });
  ok(
    "shrinking a fully paid invoice line is refused",
    !(
      await updateSaleAction(
        emptyActionState,
        fd({
          id: String(bookingLine.id),
          batchId: String(bookingLine.batchId),
          areaId: String(north.id),
          shopId: String(shopNorth.id),
          quantity: "1",
          salePrice: "500",
          saleDate: `${YEAR}-06-02`,
        }),
      )
    ).ok,
  );
  const grown = await updateSaleAction(
    emptyActionState,
    fd({
      id: String(bookingLine.id),
      batchId: String(bookingLine.batchId),
      areaId: String(north.id),
      shopId: String(shopNorth.id),
      quantity: "12",
      salePrice: "500",
      saleDate: `${YEAR}-06-02`,
    }),
  );
  ok("growing it is allowed - the invoice stays above what was paid", grown.ok, grown);
  ok("stock reconciles after all of that", await stockReconciles());

  section("cancelled and removed records refuse edits");
  await softDeleteBookingAction(emptyActionState, fd({ id: String(booking.id) }));
  ok(
    "a cancelled booking cannot be edited",
    !(
      await updateBookingAction(
        emptyActionState,
        fd({
          id: String(booking.id),
          areaId: String(north.id),
          bookingDate: `${YEAR}-06-02`,
        }),
      )
    ).ok,
  );
  ok("stock reconciles at the end", await stockReconciles());

  console.log(`\n${checks - failures}/${checks} edit checks passed`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
