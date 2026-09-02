/**
 * Bookers: CRUD, attribution, and the performance metrics built on it.
 */
import { prisma } from "@/lib/db";
import { emptyActionState } from "@/lib/validations";
import { createBatchAction } from "@/actions/batches";
import { createBookingAction, softDeleteBookingAction } from "@/actions/bookings";
import { recordPaymentAction } from "@/actions/payments";
import {
  createBookerAction,
  deleteBookerAction,
  toggleBookerActiveAction,
  updateBookerAction,
} from "@/actions/bookers";
import {
  getActiveBookers,
  getBookerCoverage,
  getBookerPerformance,
  getUncoveredAreas,
} from "@/lib/bookers";
import { getBookingList } from "@/lib/bookings";

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

async function main() {
  const product = await prisma.product.findUniqueOrThrow({ where: { sku: "MNG-BTL-250" } });
  const downtown = await prisma.area.findFirstOrThrow({ where: { name: "Downtown" } });
  const north = await prisma.area.findFirstOrThrow({ where: { name: "North Zone" } });
  const shopA = await prisma.shop.findFirstOrThrow({ where: { name: "Central Mart" } });
  const shopB = await prisma.shop.findFirstOrThrow({ where: { name: "Corner Store" } });

  await createBatchAction(
    emptyActionState,
    fd({
      productId: String(product.id),
      quantity: "5000",
      unitCost: "200",
      receivedDate: `${YEAR}-01-05`,
      idempotencyKey: "bkr-batch",
    }),
  );

  section("CRUD");
  const made = await createBookerAction(
    emptyActionState,
    fd({ name: "Imran Ali", code: "B-04", phone: "0300-1112223", notes: "North route" }),
  );
  ok("booker created", made.ok, made);
  const dup = await createBookerAction(emptyActionState, fd({ name: "Imran Ali" }));
  ok("duplicate name refused", !dup.ok, dup);
  const blank = await createBookerAction(emptyActionState, fd({ name: "" }));
  ok("blank name refused", !blank.ok && !!blank.fieldErrors.name, blank.fieldErrors);

  const imran = await prisma.booker.findFirstOrThrow({ where: { name: "Imran Ali" } });
  ok("code and phone stored", imran.code === "B-04" && imran.phone === "0300-1112223", imran);

  const renamed = await updateBookerAction(
    emptyActionState,
    fd({ id: String(imran.id), name: "Imran Ali Khan", code: "B-04", phone: "0300-9998887" }),
  );
  ok("booker updated", renamed.ok, renamed);
  const afterEdit = await prisma.booker.findUniqueOrThrow({ where: { id: imran.id } });
  ok("name and phone changed", afterEdit.name === "Imran Ali Khan" && afterEdit.phone === "0300-9998887");

  const second = await createBookerAction(emptyActionState, fd({ name: "Bilal Ahmed", code: "B-07" }));
  ok("second booker created", second.ok, second);
  const bilal = await prisma.booker.findFirstOrThrow({ where: { name: "Bilal Ahmed" } });

  ok("both appear in the active picker", (await getActiveBookers()).length === 2);

  section("retire vs remove");
  const retired = await toggleBookerActiveAction(emptyActionState, fd({ id: String(bilal.id) }));
  ok("retired", retired.ok, retired);
  ok("retired booker drops out of the picker", (await getActiveBookers()).length === 1);
  ok(
    "but is still listed for reporting",
    (await prisma.booker.count({ where: { isDeleted: false } })) === 2,
  );
  const restored = await toggleBookerActiveAction(emptyActionState, fd({ id: String(bilal.id) }));
  ok("restored", restored.ok && (await getActiveBookers()).length === 2, restored);

  const spare = await createBookerAction(emptyActionState, fd({ name: "Typo Person" }));
  ok("throwaway booker created", spare.ok);
  const typo = await prisma.booker.findFirstOrThrow({ where: { name: "Typo Person" } });
  const removed = await deleteBookerAction(emptyActionState, fd({ id: String(typo.id) }));
  ok("a booker with no bookings can be removed", removed.ok, removed);
  const readd = await createBookerAction(emptyActionState, fd({ name: "Typo Person" }));
  ok("re-adding the same name restores rather than duplicating", readd.ok, readd);
  ok(
    "still only one row for that name",
    (await prisma.booker.count({ where: { name: "Typo Person" } })) === 1,
  );
  await deleteBookerAction(
    emptyActionState,
    fd({ id: String((await prisma.booker.findFirstOrThrow({ where: { name: "Typo Person" } })).id) }),
  );

  section("attribution");
  // Imran: two orders in Downtown, one shop. 10 x 450 = 4,500 each.
  for (const [i, shopId] of [shopA.id, shopA.id].entries()) {
    const r = await createBookingAction(
      emptyActionState,
      fd({
        bookerId: String(imran.id),
        customerName: `Imran Customer ${i + 1}`,
        areaId: String(downtown.id),
        shopId: String(shopId),
        bookingDate: `${YEAR}-03-0${i + 1}`,
        lines: JSON.stringify([{ productId: product.id, quantity: 10, unitPrice: 450 }]),
        idempotencyKey: `bkr-imran-${i}`,
      }),
    );
    ok(`Imran booking ${i + 1} created`, r.ok, r);
  }
  // Bilal: one order in Downtown (different shop), one in North Zone.
  for (const [i, [areaId, shopId]] of (
    [
      [downtown.id, shopB.id],
      [north.id, null],
    ] as [number, number | null][]
  ).entries()) {
    const r = await createBookingAction(
      emptyActionState,
      fd({
        bookerId: String(bilal.id),
        customerName: `Bilal Customer ${i + 1}`,
        areaId: String(areaId),
        ...(shopId != null ? { shopId: String(shopId) } : {}),
        bookingDate: `${YEAR}-03-1${i + 1}`,
        lines: JSON.stringify([{ productId: product.id, quantity: 20, unitPrice: 450 }]),
        idempotencyKey: `bkr-bilal-${i}`,
      }),
    );
    ok(`Bilal booking ${i + 1} created`, r.ok, r);
  }

  const list = await getBookingList({
    from: null, to: null, areaId: null, bookerId: null, q: null, page: 1,
  });
  ok("bookings list names the booker", list.rows.every((r) => r.bookerName !== null), list.rows.map((r) => r.bookerName));
  const imranOnly = await getBookingList({
    from: null, to: null, areaId: null, bookerId: imran.id, q: null, page: 1,
  });
  ok("the booker filter works", imranOnly.total === 2, imranOnly.total);

  section("performance");
  let perf = await getBookerPerformance({ year: YEAR, areaId: null });
  const rImran = perf.rows.find((r) => r.id === imran.id)!;
  const rBilal = perf.rows.find((r) => r.id === bilal.id)!;

  ok("Imran: 2 bookings", rImran.bookings === 2, rImran.bookings);
  ok("Imran: booked value 9,000", near(rImran.bookedValue, 9000), rImran.bookedValue);
  ok("Imran: profit 2 x 10 x 250 = 5,000", near(rImran.bookedProfit, 5000), rImran.bookedProfit);
  ok("Imran: avg order 4,500", near(rImran.avgOrderValue ?? 0, 4500), rImran.avgOrderValue);
  ok("Imran: 1 area, 1 shop", rImran.areasCovered === 1 && rImran.shopsCovered === 1, rImran);
  ok("Imran: 20 units", rImran.units === 20, rImran.units);

  ok("Bilal: 2 bookings", rBilal.bookings === 2, rBilal.bookings);
  ok("Bilal: booked value 18,000", near(rBilal.bookedValue, 18000), rBilal.bookedValue);
  ok("Bilal: covers 2 areas", rBilal.areasCovered === 2, rBilal.areasCovered);
  ok("sorted by booked value, so Bilal leads", perf.rows[0].id === bilal.id, perf.rows.map((r) => r.name));
  ok("nothing collected yet", near(perf.totals.collected, 0), perf.totals);
  ok("all 27,000 outstanding", near(perf.totals.outstanding, 27000), perf.totals);
  ok("collection rate is 0%", near(rImran.collectionRate ?? -1, 0), rImran.collectionRate);

  section("collection is what separates them");
  // Imran collects in full on one order; Bilal collects nothing.
  const imranBooking = await prisma.booking.findFirstOrThrow({
    where: { idempotencyKey: "bkr-imran-0" },
  });
  const paid = await recordPaymentAction(
    emptyActionState,
    fd({
      bookingId: String(imranBooking.id),
      amount: "4500",
      paidOn: `${YEAR}-03-05`,
      idempotencyKey: "bkr-pay-1",
    }),
  );
  ok("payment recorded", paid.ok, paid);

  perf = await getBookerPerformance({ year: YEAR, areaId: null });
  const rImran2 = perf.rows.find((r) => r.id === imran.id)!;
  const rBilal2 = perf.rows.find((r) => r.id === bilal.id)!;
  ok("Imran collected 4,500", near(rImran2.collected, 4500), rImran2.collected);
  ok("Imran rate is 50%", near(rImran2.collectionRate ?? 0, 50), rImran2.collectionRate);
  ok("Imran outstanding 4,500", near(rImran2.outstanding, 4500), rImran2.outstanding);
  ok("Bilal collected nothing", near(rBilal2.collected, 0), rBilal2.collected);
  ok("Bilal rate is 0%", near(rBilal2.collectionRate ?? -1, 0), rBilal2.collectionRate);
  ok(
    "days to settle measured on the settled order (03-01 -> 03-05 = 4)",
    near(rImran2.avgDaysToSettle ?? -1, 4),
    rImran2.avgDaysToSettle,
  );
  ok("Bilal has no settled order, so no average", rBilal2.avgDaysToSettle === null, rBilal2.avgDaysToSettle);

  section("area filter narrows to that area's work");
  const dtOnly = await getBookerPerformance({ year: YEAR, areaId: downtown.id });
  ok(
    "Bilal's Downtown value only (one 9,000 order)",
    near(dtOnly.rows.find((r) => r.id === bilal.id)!.bookedValue, 9000),
    dtOnly.rows.find((r) => r.id === bilal.id)!.bookedValue,
  );
  ok(
    "Imran unchanged, he only works Downtown",
    near(dtOnly.rows.find((r) => r.id === imran.id)!.bookedValue, 9000),
  );

  section("coverage");
  const coverage = await getBookerCoverage({ year: YEAR });
  ok("coverage has a row per booker+area", coverage.length === 3, coverage);
  ok(
    "Bilal shows in both areas",
    coverage.filter((c) => c.bookerName === "Bilal Ahmed").length === 2,
    coverage,
  );
  const uncovered = await getUncoveredAreas({ year: YEAR });
  ok("seeded areas with no orders are reported", uncovered.length >= 1, uncovered);
  ok("Downtown is not among them", !uncovered.includes("Downtown"), uncovered);

  section("unattributed bookings are surfaced, not hidden");
  const noBooker = await createBookingAction(
    emptyActionState,
    fd({
      customerName: "No Booker",
      areaId: String(downtown.id),
      bookingDate: `${YEAR}-03-20`,
      lines: JSON.stringify([{ productId: product.id, quantity: 1, unitPrice: 450 }]),
      idempotencyKey: "bkr-none",
    }),
  );
  ok("a booking with no booker is still allowed", noBooker.ok, noBooker);
  perf = await getBookerPerformance({ year: YEAR, areaId: null });
  ok("its 450 is reported as unattributed", near(perf.totals.unattributed, 450), perf.totals);
  ok(
    "and is not credited to anyone",
    near(perf.rows.reduce((s, r) => s + r.bookedValue, 0), 27000),
    perf.rows.map((r) => r.bookedValue),
  );

  section("a booker with bookings cannot be removed");
  const blocked = await deleteBookerAction(emptyActionState, fd({ id: String(imran.id) }));
  ok("removal refused", !blocked.ok, blocked);
  ok("the message points at retiring instead", (blocked.message ?? "").toLowerCase().includes("retire"), blocked.message);
  ok("still present", (await prisma.booker.findUniqueOrThrow({ where: { id: imran.id } })).isDeleted === false);

  section("cancelling a booking removes it from the booker's numbers");
  const before = (await getBookerPerformance({ year: YEAR, areaId: null })).rows.find(
    (r) => r.id === imran.id,
  )!;
  await softDeleteBookingAction(
    emptyActionState,
    fd({ id: String((await prisma.booking.findFirstOrThrow({ where: { idempotencyKey: "bkr-imran-1" } })).id) }),
  );
  const after = (await getBookerPerformance({ year: YEAR, areaId: null })).rows.find(
    (r) => r.id === imran.id,
  )!;
  ok("bookings count drops", after.bookings === before.bookings - 1, [before.bookings, after.bookings]);
  ok("booked value drops by 4,500", near(after.bookedValue, before.bookedValue - 4500), after.bookedValue);
  ok("collection rate recomputes to 100%", near(after.collectionRate ?? 0, 100), after.collectionRate);

  console.log(`\n${checks - failures}/${checks} booker checks passed`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
