/**
 * Cash-basis revenue recognition.
 *
 * The rule under test: a booking counts as revenue only when the money arrives,
 * in proportion to how much arrived, dated by the payment. Counter sales (no
 * booking) count in full on their sale date.
 */
import { prisma } from "@/lib/db";
import { emptyActionState } from "@/lib/validations";
import { createBatchAction } from "@/actions/batches";
import { createBookingAction, softDeleteBookingAction } from "@/actions/bookings";
import { createSaleAction } from "@/actions/sales";
import { deletePaymentAction, recordPaymentAction } from "@/actions/payments";
import {
  getAwaitingPayment,
  getCashByArea,
  getCashByCategory,
  getCashByPackaging,
  getCashKpis,
  getCashMonthlyTrend,
} from "@/lib/recognition";
import { getStockLevels, type Scope } from "@/lib/queries";
import { yearRange } from "@/lib/dates";

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
const F = { year: YEAR, categoryId: null, areaId: null };
const scope = (): Scope => ({ ...yearRange(YEAR), categoryId: null, areaId: null });

async function main() {
  const mango = await prisma.product.findUniqueOrThrow({ where: { sku: "MNG-BTL-250" } });
  const choco = await prisma.product.findUniqueOrThrow({ where: { sku: "CHO-BAR-10" } });
  const area = await prisma.area.findFirstOrThrow({ where: { name: "Downtown" } });
  const north = await prisma.area.findFirstOrThrow({ where: { name: "North Zone" } });

  // Cost 200 each, sold at 450: margin 250 a unit.
  await createBatchAction(
    emptyActionState,
    fd({
      productId: String(mango.id),
      quantity: "1000",
      unitCost: "200",
      receivedDate: `${YEAR}-01-05`,
      idempotencyKey: "rec-mango",
    }),
  );
  await createBatchAction(
    emptyActionState,
    fd({
      productId: String(choco.id),
      quantity: "1000",
      unitCost: "6",
      receivedDate: `${YEAR}-01-05`,
      idempotencyKey: "rec-choco",
    }),
  );

  section("a delivered but UNPAID booking counts nothing");
  // 100 x 450 = 45,000 invoice, cost 20,000, so margin 25,000.
  const booked = await createBookingAction(
    emptyActionState,
    fd({
      customerName: "Credit Buyer",
      areaId: String(area.id),
      bookingDate: `${YEAR}-03-10`,
      lines: JSON.stringify([{ productId: mango.id, quantity: 100, unitPrice: 450 }]),
      idempotencyKey: "rec-booking",
    }),
  );
  ok("booking created", booked.ok, booked);
  const booking = await prisma.booking.findFirstOrThrow({
    where: { idempotencyKey: "rec-booking" },
  });

  const k0 = await getCashKpis(F);
  ok("revenue is zero", near(k0.year.revenue, 0), k0.year.revenue);
  ok("profit is zero", near(k0.year.profit, 0), k0.year.profit);
  ok("but the stock has gone", (await getStockLevels()).find((s) => s.sku === "MNG-BTL-250")!.currentStock === 900);
  ok("and it shows as awaiting payment", near(k0.awaitingPayment, 45000), k0.awaitingPayment);
  ok("units DELIVERED still counts the 100", k0.year.units === 100, k0.year.units);

  section("a partial payment counts in proportion");
  // 20,000 of 45,000 = 4/9. Profit recognised = 25,000 x 4/9 = 11,111.11
  const p1 = await recordPaymentAction(
    emptyActionState,
    fd({
      bookingId: String(booking.id),
      amount: "20000",
      paidOn: `${YEAR}-04-05`,
      idempotencyKey: "rec-pay-1",
    }),
  );
  ok("payment recorded", p1.ok, p1);

  const k1 = await getCashKpis(F);
  ok("revenue = the 20,000 received", near(k1.year.revenue, 20000), k1.year.revenue);
  ok(
    "profit = 25,000 x 20,000/45,000 = 11,111.11",
    near(k1.year.profit, 25000 * (20000 / 45000)),
    k1.year.profit,
  );
  ok("margin holds at 55.6%", near((k1.year.profit / k1.year.revenue) * 100, 55.5556), (k1.year.profit / k1.year.revenue) * 100);
  ok("awaiting payment drops to 25,000", near(k1.awaitingPayment, 25000), k1.awaitingPayment);

  section("it is dated by the PAYMENT, not the delivery");
  const t1 = await getCashMonthlyTrend(F);
  ok("March (delivered) counts nothing", near(t1[2].revenue, 0), t1[2].revenue);
  ok("April (paid) counts the 20,000", near(t1[3].revenue, 20000), t1[3].revenue);
  ok("April profit is the proportional share", near(t1[3].profit, 25000 * (20000 / 45000)), t1[3].profit);

  section("the rest, paid in a later month, lands in that month");
  const p2 = await recordPaymentAction(
    emptyActionState,
    fd({
      bookingId: String(booking.id),
      amount: "25000",
      paidOn: `${YEAR}-06-20`,
      idempotencyKey: "rec-pay-2",
    }),
  );
  ok("second payment recorded", p2.ok, p2);

  const k2 = await getCashKpis(F);
  ok("revenue is now the whole 45,000", near(k2.year.revenue, 45000), k2.year.revenue);
  ok("profit is now the whole 25,000", near(k2.year.profit, 25000), k2.year.profit);
  ok("nothing awaiting payment", near(k2.awaitingPayment, 0), k2.awaitingPayment);

  const t2 = await getCashMonthlyTrend(F);
  ok("April keeps its 20,000", near(t2[3].revenue, 20000), t2[3].revenue);
  ok("June gets the other 25,000", near(t2[5].revenue, 25000), t2[5].revenue);
  ok(
    "the two months' profit adds to the full margin",
    near(t2[3].profit + t2[5].profit, 25000),
    [t2[3].profit, t2[5].profit],
  );
  ok(
    "the year equals the sum of its months",
    near(
      t2.reduce((s, m) => s + m.revenue, 0),
      k2.year.revenue,
    ),
  );

  section("a counter sale counts in full, immediately");
  const batch = await prisma.batch.findFirstOrThrow({
    where: { idempotencyKey: "rec-choco" },
    select: { id: true },
  });
  const counter = await createSaleAction(
    emptyActionState,
    fd({
      productId: String(choco.id),
      batchId: String(batch.id),
      areaId: String(north.id),
      quantity: "100",
      salePrice: "15",
      saleDate: `${YEAR}-05-02`,
      idempotencyKey: "rec-counter",
    }),
  );
  ok("counter sale recorded", counter.ok, counter);

  const k3 = await getCashKpis(F);
  //  1,500 revenue, cost 600, profit 900
  ok("revenue includes the 1,500 at once", near(k3.year.revenue, 45000 + 1500), k3.year.revenue);
  ok("profit includes its 900 at once", near(k3.year.profit, 25000 + 900), k3.year.profit);
  ok("it does not appear as awaiting payment", near(k3.awaitingPayment, 0), k3.awaitingPayment);
  const t3 = await getCashMonthlyTrend(F);
  ok("and it lands in May, its sale date", near(t3[4].revenue, 1500), t3[4].revenue);

  section("breakdowns are on the same basis and reconcile");
  const byArea = await getCashByArea(scope());
  ok(
    "areas sum to the recognised revenue",
    near(byArea.reduce((s, r) => s + r.revenue, 0), k3.year.revenue),
    byArea,
  );
  ok(
    "Downtown shows the booking money only",
    near(byArea.find((r) => r.label === "Downtown")?.revenue ?? 0, 45000),
    byArea,
  );
  ok(
    "North Zone shows the counter sale only",
    near(byArea.find((r) => r.label === "North Zone")?.revenue ?? 0, 1500),
    byArea,
  );
  const byCat = await getCashByCategory(scope());
  ok(
    "categories sum to the same total",
    near(byCat.reduce((s, r) => s + r.revenue, 0), k3.year.revenue),
    byCat,
  );
  const byPack = await getCashByPackaging(scope());
  ok(
    "packaging sums to the same total",
    near(byPack.reduce((s, r) => s + r.revenue, 0), k3.year.revenue),
    byPack,
  );

  section("reversing a payment un-counts its revenue");
  const firstPayment = await prisma.payment.findFirstOrThrow({
    where: { idempotencyKey: "rec-pay-1" },
    select: { id: true },
  });
  const rev = await deletePaymentAction(emptyActionState, fd({ id: String(firstPayment.id) }));
  ok("reversed", rev.ok, rev);
  const k4 = await getCashKpis(F);
  ok("revenue drops by the 20,000", near(k4.year.revenue, 25000 + 1500), k4.year.revenue);
  ok("and it is owed again", near(k4.awaitingPayment, 20000), k4.awaitingPayment);
  const t4 = await getCashMonthlyTrend(F);
  ok("April is empty again", near(t4[3].revenue, 0), t4[3].revenue);

  section("cancelling a booking removes it entirely");
  const cancelled = await softDeleteBookingAction(emptyActionState, fd({ id: String(booking.id) }));
  ok("cancelled", cancelled.ok, cancelled);
  const k5 = await getCashKpis(F);
  ok("only the counter sale remains", near(k5.year.revenue, 1500), k5.year.revenue);
  ok("its profit too", near(k5.year.profit, 900), k5.year.profit);
  ok("nothing awaiting payment", near(k5.awaitingPayment, 0), k5.awaitingPayment);
  ok("stock came back", (await getStockLevels()).find((s) => s.sku === "MNG-BTL-250")!.currentStock === 1000);

  section("recognised revenue can never exceed what was invoiced");
  // Force the pathological case straight in SQL: a payment far larger than the
  // invoice, which the app itself refuses.
  const b2 = await createBookingAction(
    emptyActionState,
    fd({
      customerName: "Overpay Test",
      areaId: String(area.id),
      bookingDate: `${YEAR}-07-01`,
      lines: JSON.stringify([{ productId: mango.id, quantity: 10, unitPrice: 450 }]),
      idempotencyKey: "rec-over",
    }),
  );
  ok("small booking created (4,500)", b2.ok, b2);
  const over = await prisma.booking.findFirstOrThrow({ where: { idempotencyKey: "rec-over" } });
  await prisma.$executeRawUnsafe(
    `INSERT INTO payments (booking_id, amount, paid_on, updated_at)
     VALUES (${over.id}, 999999, '${YEAR}-07-02', now())`,
  );
  const k6 = await getCashKpis(F);
  ok(
    "the 999,999 is capped at the 4,500 invoiced",
    near(k6.year.revenue, 1500 + 4500),
    k6.year.revenue,
  );
  ok(
    "profit is capped with it (10 x 250 = 2,500)",
    near(k6.year.profit, 900 + 2500),
    k6.year.profit,
  );

  section("awaiting payment never goes negative");
  ok("still zero, not negative", (await getAwaitingPayment({ areaId: null })) >= 0);

  console.log(`\n${checks - failures}/${checks} recognition checks passed`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
