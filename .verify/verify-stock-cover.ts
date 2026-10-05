/**
 * How long the stock will last, and the ways that figure lies if you let it.
 *
 * The dangerous one is a line that started selling partway through the window.
 * Dividing its sales by the whole window reports a rate a fraction of the
 * truth, and a fraction of the truth here means a product quietly reported as
 * having two months of cover on the day it runs out. That is the case this
 * suite is mostly about.
 */
import { prisma } from "@/lib/db";
import { emptyActionState } from "@/lib/validations";
import { createBatchAction } from "@/actions/batches";
import { createBookingAction } from "@/actions/bookings";
import { getStockCover } from "@/lib/queries";

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

/** A fixed today, so the arithmetic has a known answer. */
const TODAY = new Date("2026-05-31T12:00:00Z");
const near = (a: number, b: number, slack = 0.05) => Math.abs(a - b) <= slack;

async function main() {
  const area = await prisma.area.findFirstOrThrow({ where: { name: "Downtown" } });
  const shop = await prisma.shop.findFirstOrThrow({ where: { name: "Central Mart" } });

  /** Selling the whole window: 300 units over 30 days = 10 a day. */
  const steady = await prisma.product.findUniqueOrThrow({ where: { sku: "MNG-BTL-250" } });
  /** First sold five days ago: 50 units over 5 days is ALSO 10 a day. */
  const fresh = await prisma.product.findUniqueOrThrow({ where: { sku: "MNG-BTL-500" } });
  /** Stocked and never sold. */
  const idle = await prisma.product.findUniqueOrThrow({ where: { sku: "CHO-BAR-10" } });

  for (const [p, n, key] of [
    [steady, 400, "sc-batch-steady"],
    [fresh, 150, "sc-batch-fresh"],
    [idle, 80, "sc-batch-idle"],
  ] as const) {
    await createBatchAction(
      emptyActionState,
      fd({
        productId: String(p.id),
        quantity: String(n),
        unitCost: "200",
        receivedDate: "2026-04-25",
        idempotencyKey: key,
      }),
    );
  }

  /** Ten a day for thirty days, booked as three sales across the window. */
  const steadyDates = ["2026-05-01", "2026-05-15", "2026-05-30"];
  for (const [i, d] of steadyDates.entries()) {
    await createBookingAction(
      emptyActionState,
      fd({
        customerName: "Steady",
        areaId: String(area.id),
        shopId: String(shop.id),
        bookingDate: d,
        lines: JSON.stringify([{ productId: steady.id, quantity: 100, unitPrice: 450 }]),
        idempotencyKey: `sc-steady-${i}`,
      }),
    );
  }

  /** Fifty units, all of them inside the last five days. */
  await createBookingAction(
    emptyActionState,
    fd({
      customerName: "Fresh",
      areaId: String(area.id),
      shopId: String(shop.id),
      bookingDate: "2026-05-26",
      lines: JSON.stringify([{ productId: fresh.id, quantity: 50, unitPrice: 750 }]),
      idempotencyKey: "sc-fresh-0",
    }),
  );

  const { rows, dataDays } = await getStockCover(30, TODAY);
  const find = (id: number) => rows.find((r) => r.productId === id);

  section("a line selling across the whole window");
  const s = find(steady.id);
  ok("it is reported", s != null, rows.map((r) => r.sku));
  ok("every unit in the window is counted", s?.unitsSold === 300, s);
  ok("the window is its selling life", s?.activeDays === 30, s?.activeDays);
  ok("ten a day", s != null && near(s.unitsPerDay, 10), s?.unitsPerDay);
  ok("400 in, 300 out, 100 left", s?.currentStock === 100, s?.currentStock);
  ok("so ten days of cover", s?.daysOfCover != null && near(s.daysOfCover, 10), s?.daysOfCover);

  section("a line that only started selling five days ago");
  const f = find(fresh.id);
  ok("fifty units sold", f?.unitsSold === 50, f);
  ok(
    "counted over the five days it has been selling, not thirty",
    f?.activeDays === 5,
    f?.activeDays,
  );
  ok("which is also ten a day", f != null && near(f.unitsPerDay, 10), f?.unitsPerDay);
  ok("100 left", f?.currentStock === 100, f?.currentStock);
  ok(
    "ten days of cover - not sixty, which dividing by the window would give",
    f?.daysOfCover != null && near(f.daysOfCover, 10),
    f?.daysOfCover,
  );

  section("a line holding stock that has not sold");
  const i = find(idle.id);
  ok("it still appears", i != null);
  ok("nothing sold", i?.unitsSold === 0, i);
  ok("cover is unknown, not zero", i?.daysOfCover === null, i?.daysOfCover);
  ok(
    "and it sorts below everything that is actually selling",
    rows.findIndex((r) => r.productId === idle.id) >
      Math.max(
        rows.findIndex((r) => r.productId === steady.id),
        rows.findIndex((r) => r.productId === fresh.id),
      ),
  );

  section("ordering and honesty about the data");
  const selling = rows.filter((r) => r.daysOfCover != null);
  ok(
    "the soonest to run out is first",
    selling.every((r, n) => n === 0 || selling[n - 1]!.daysOfCover! <= r.daysOfCover!),
    selling.map((r) => r.daysOfCover),
  );
  ok("it reports how much history it had", dataDays === 30, dataDays);

  section("selling with nothing left");
  await createBookingAction(
    emptyActionState,
    fd({
      customerName: "Clears it out",
      areaId: String(area.id),
      shopId: String(shop.id),
      bookingDate: "2026-05-30",
      lines: JSON.stringify([{ productId: fresh.id, quantity: 100, unitPrice: 750 }]),
      idempotencyKey: "sc-fresh-1",
    }),
  );
  const after = await getStockCover(30, TODAY);
  const empty = after.rows.find((r) => r.productId === fresh.id);
  ok("stock is gone", empty?.currentStock === 0, empty?.currentStock);
  ok("cover is zero, not unknown", empty?.daysOfCover === 0, empty?.daysOfCover);
  ok("and it is now the most urgent row", after.rows[0]?.productId === fresh.id, after.rows[0]?.sku);

  console.log(`\n${checks - failures}/${checks} stock cover checks passed`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
