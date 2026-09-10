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
import { createBookerAction } from "@/actions/bookers";
import {
  getCashRangeTotals,
  getAwaitingPayment,
  getCashByArea,
  getCashByBooker,
  getCashByCategory,
  getCashByPackaging,
  getCashKpis,
  getCashMonthlyTrend,
  type CashScope,
} from "@/lib/recognition";
import { getStockLevels } from "@/lib/queries";
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
const F = { year: YEAR, categoryId: null, areaId: null, bookerId: null };
const scope = (): CashScope => ({
  ...yearRange(YEAR),
  categoryId: null,
  areaId: null,
  bookerId: null,
});

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
  ok(
    "but the stock has gone",
    (await getStockLevels()).find((s) => s.sku === "MNG-BTL-250")!.currentStock === 900,
  );
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
  ok(
    "margin holds at 55.6%",
    near((k1.year.profit / k1.year.revenue) * 100, 55.5556),
    (k1.year.profit / k1.year.revenue) * 100,
  );
  ok("awaiting payment drops to 25,000", near(k1.awaitingPayment, 25000), k1.awaitingPayment);

  section("it is dated by the PAYMENT, not the delivery");
  const t1 = await getCashMonthlyTrend(F);
  ok("March (delivered) counts nothing", near(t1[2].revenue, 0), t1[2].revenue);
  ok("April (paid) counts the 20,000", near(t1[3].revenue, 20000), t1[3].revenue);
  ok(
    "April profit is the proportional share",
    near(t1[3].profit, 25000 * (20000 / 45000)),
    t1[3].profit,
  );

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
  ok("the two months' profit adds to the full margin", near(t2[3].profit + t2[5].profit, 25000), [
    t2[3].profit,
    t2[5].profit,
  ]);
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
    near(
      byArea.reduce((s, r) => s + r.revenue, 0),
      k3.year.revenue,
    ),
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
    near(
      byCat.reduce((s, r) => s + r.revenue, 0),
      k3.year.revenue,
    ),
    byCat,
  );
  const byPack = await getCashByPackaging(scope());
  ok(
    "packaging sums to the same total",
    near(
      byPack.reduce((s, r) => s + r.revenue, 0),
      k3.year.revenue,
    ),
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
  ok(
    "stock came back",
    (await getStockLevels()).find((s) => s.sku === "MNG-BTL-250")!.currentStock === 1000,
  );

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

  section("the booker dimension");
  // A booker takes one order; the counter sales already recorded above have no
  // booker at all, which is what the "no booker" bucket has to account for.
  const madeBooker = await createBookerAction(emptyActionState, fd({ name: "Rec Booker" }));
  ok("booker created", madeBooker.ok, madeBooker);
  const recBooker = await prisma.booker.findFirstOrThrow({ where: { name: "Rec Booker" } });

  const attributed = await createBookingAction(
    emptyActionState,
    fd({
      bookerId: String(recBooker.id),
      customerName: "Attributed",
      areaId: String(area.id),
      bookingDate: `${YEAR}-08-01`,
      lines: JSON.stringify([{ productId: mango.id, quantity: 4, unitPrice: 500 }]),
      idempotencyKey: "rec-booker-1",
    }),
  );
  ok("their booking was taken", attributed.ok, attributed);
  const attributedBooking = await prisma.booking.findFirstOrThrow({
    where: { idempotencyKey: "rec-booker-1" },
  });

  const before = await getCashKpis(F);
  const byBookerBefore = await getCashByBooker(scope());
  ok(
    "unpaid, so nothing is credited to them yet",
    !byBookerBefore.some((r) => r.label === "Rec Booker"),
    byBookerBefore.map((r) => r.label),
  );

  const halfPaid = await recordPaymentAction(
    emptyActionState,
    fd({
      bookingId: String(attributedBooking.id),
      amount: "1000",
      paidOn: `${YEAR}-08-10`,
      idempotencyKey: "rec-booker-pay",
    }),
  );
  ok("half of the 2,000 order is paid", halfPaid.ok, halfPaid);

  const byBooker = await getCashByBooker(scope());
  const mine = byBooker.find((r) => r.label === "Rec Booker");
  ok(
    "they now have a row",
    mine != null,
    byBooker.map((r) => r.label),
  );
  ok("credited only the 1,000 received", near(mine?.revenue ?? 0, 1000), mine?.revenue);

  const noBooker = byBooker.find((r) => r.label === "Counter sale (no booker)");
  ok(
    "counter sales are their own row, not dropped",
    noBooker != null,
    byBooker.map((r) => r.label),
  );
  ok(
    "the by-booker rows still add up to total revenue",
    near(
      byBooker.reduce((t, r) => t + r.revenue, 0),
      before.year.revenue + 1000,
    ),
    [byBooker.reduce((t, r) => t + r.revenue, 0), before.year.revenue + 1000],
  );

  const filtered = await getCashKpis({ ...F, bookerId: recBooker.id });
  ok(
    "filtering by booker isolates their 1,000",
    near(filtered.year.revenue, 1000),
    filtered.year.revenue,
  );
  ok(
    "and their profit on it (1,000/2,000 of 4 x 300 margin)",
    near(filtered.year.profit, 600),
    filtered.year.profit,
  );
  ok(
    "delivered units follow the same filter (4 packs)",
    filtered.year.units === 4,
    filtered.year.units,
  );
  ok(
    "the remaining 1,000 shows as awaiting payment for them",
    near(await getAwaitingPayment({ areaId: null, bookerId: recBooker.id }), 1000),
    await getAwaitingPayment({ areaId: null, bookerId: recBooker.id }),
  );
  const trendFiltered = await getCashMonthlyTrend({ ...F, bookerId: recBooker.id });
  ok(
    "and it lands in August, the month it was paid",
    near(trendFiltered[7].revenue, 1000) &&
      trendFiltered.every((m, i) => i === 7 || m.revenue === 0),
    trendFiltered.filter((m) => m.revenue > 0),
  );

  const unattributedFilter = await getCashKpis({ ...F, bookerId: 999999 });
  ok(
    "an unknown booker yields nothing rather than everything",
    near(unattributedFilter.year.revenue, 0),
    unattributedFilter.year.revenue,
  );

  section("awaiting payment never goes negative");
  ok("still zero, not negative", (await getAwaitingPayment({ areaId: null })) >= 0);

  /* ------------------------------------------------------- date ranges */
  section("a chosen date range adds up");

  // The dashboard turns a "to" date into the day AFTER it, because every cash
  // query is on_date >= start AND on_date < end. Get that wrong by one day and
  // the last day of every range silently disappears - which reads as a quiet
  // day of trade, not as a bug. This is the arithmetic that proves it: the days
  // of a period, summed one at a time, must equal the period asked for in one
  // go. A gap fails it and so does a double count.
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const nextDay = (iso: string) => new Date(day(iso).getTime() + 86400000);
  const asIso = (dt: Date) => dt.toISOString().slice(0, 10);

  const bounds = await prisma.$queryRaw<{ first: Date | null; last: Date | null }[]>`
    SELECT MIN(paid_on) AS first, MAX(paid_on) AS last
      FROM payments WHERE is_deleted = false`;
  const firstPaid = bounds[0]?.first ?? null;
  const lastPaid = bounds[0]?.last ?? null;

  if (firstPaid && lastPaid) {
    const startIso = asIso(firstPaid);
    const endIso = asIso(lastPaid);
    const scope = { categoryId: null, areaId: null, bookerId: null };

    const whole = await getCashRangeTotals({
      ...scope,
      start: day(startIso),
      end: nextDay(endIso),
    });

    let summed = { revenue: 0, profit: 0, units: 0 };
    for (
      let cursor = day(startIso);
      cursor <= lastPaid;
      cursor = new Date(cursor.getTime() + 86400000)
    ) {
      const oneDay = await getCashRangeTotals({
        ...scope,
        start: cursor,
        end: new Date(cursor.getTime() + 86400000),
      });
      summed = {
        revenue: summed.revenue + oneDay.revenue,
        profit: summed.profit + oneDay.profit,
        units: summed.units + oneDay.units,
      };
    }

    ok(
      "the days of a range, summed one by one, equal the range in one query",
      Math.abs(whole.revenue - summed.revenue) < 0.01,
      { range: whole.revenue, daily: summed.revenue },
    );
    ok("and so does the profit", Math.abs(whole.profit - summed.profit) < 0.01, {
      range: whole.profit,
      daily: summed.profit,
    });
    ok("and the units", whole.units === summed.units, { range: whole.units, daily: summed.units });
    ok("the range is not empty, so the check above means something", whole.revenue > 0, whole);

    // The inclusive end, stated directly: the last day's money is inside.
    const withoutLast = await getCashRangeTotals({
      ...scope,
      start: day(startIso),
      end: day(endIso),
    });
    const lastDay = await getCashRangeTotals({
      ...scope,
      start: day(endIso),
      end: nextDay(endIso),
    });
    ok(
      "a range ending on a day includes that day",
      Math.abs(whole.revenue - (withoutLast.revenue + lastDay.revenue)) < 0.01,
      { whole: whole.revenue, withoutLast: withoutLast.revenue, lastDay: lastDay.revenue },
    );

    /* --------------------------------------------------------- the trend */
    const spanned = await getCashMonthlyTrend({
      year: firstPaid.getUTCFullYear(),
      categoryId: null,
      areaId: null,
      bookerId: null,
      range: { start: day(startIso), end: nextDay(endIso) },
    });
    ok(
      "a ranged trend covers only the months the range touches",
      spanned.length > 0 && spanned.length <= 12,
      spanned.map((p) => p.label),
    );
    const trendRevenue = spanned.reduce((sum, p) => sum + p.revenue, 0);
    ok(
      "and its months add up to the same range total",
      Math.abs(trendRevenue - whole.revenue) < 0.01,
      { trend: trendRevenue, range: whole.revenue },
    );

    const fullYear = await getCashMonthlyTrend({
      year: firstPaid.getUTCFullYear(),
      categoryId: null,
      areaId: null,
      bookerId: null,
    });
    ok(
      "with no range it is still the twelve months of the year",
      fullYear.length === 12,
      fullYear.length,
    );
  } else {
    console.log("  SKIP  date ranges (no payments in this database)");
  }

  /* --------------------------------------------- the catalog's own order */
  section("a shop added today can be heard today");

  // This is the question a product still being added to actually has: when a
  // new shop is created, is its name offered to Whisper straight away?
  //
  // It used to be the opposite. Ordering by all-time sales put a brand new
  // shop LAST, having sold nothing yet - which is exactly backwards, because
  // that is the shop whose name you are about to say for the first time and
  // the one Whisper has never been told about. Ordering falls back to the
  // creation date so a new shop arrives at the front instead.
  //
  // No sales are needed for this, which is why it replaced a check that
  // skipped for want of them.
  const { getVoiceCatalog } = await import("@/lib/voice/answer");
  const { buildPrompt } = await import("@/lib/voice/transcribe");
  const { speechVocabulary } = await import("@/lib/voice/names");

  const promptNow = async () => buildPrompt(speechVocabulary(await getVoiceCatalog()));

  const beforeAdding = await promptNow();
  ok("a shop that does not exist is not offered", !beforeAdding.includes("zubair"), beforeAdding);

  const anyArea = await prisma.area.findFirstOrThrow({ where: { isDeleted: false } });
  const freshShop = await prisma.shop.create({
    data: { name: "Zubair kiryana", areaId: anyArea.id },
  });

  try {
    const catalogAfter = await getVoiceCatalog();
    const position = catalogAfter.shops.findIndex((sh) => sh.id === freshShop.id);
    ok("a shop added a moment ago comes back first", position === 0, {
      position,
      of: catalogAfter.shops.length,
    });

    const afterAdding = await promptNow();
    ok(
      "and its name is offered to Whisper immediately, with nothing configured",
      afterAdding.includes("zubair"),
      afterAdding,
    );

    // The derived word comes before the full name in the vocabulary, so when
    // the budget does run out it is a redundant full name that goes rather
    // than a shop nobody has heard of. Checked on the vocabulary itself
    // rather than on a name from another database.
    const vocab = speechVocabulary(catalogAfter);
    ok(
      "every derived word is offered before its own full name",
      catalogAfter.shops.every((sh) => {
        const short = vocab.indexOf(sh.name.toLowerCase().split(/[^a-z0-9]+/i)[0] ?? "");
        const full = vocab.indexOf(sh.name);
        return short === -1 || full === -1 || short < full;
      }),
      vocab,
    );
  } finally {
    // Created for the check and removed again: it has no sales, so nothing
    // else in this suite can see it.
    await prisma.shop.delete({ where: { id: freshShop.id } });
  }

  /* --------------------------------------------------- the voice log */
  section("what was said is written down");

  const { logVoiceAttempt, markVoiceAttemptSaved } = await import("@/lib/voice/log");

  const attemptId = await logVoiceAttempt({
    transcript: "saleem ko bees aam ki chhoti bottle",
    engine: "whisper",
    language: "ur",
    kind: "booking",
    model: "whisper-large-v3",
    noSpeechProb: 0.04,
  });
  ok("an attempt comes back with an id to attribute a save to", attemptId != null, attemptId);

  const logged = await prisma.voiceAttempt.findUniqueOrThrow({ where: { id: attemptId! } });
  ok("the transcript is kept exactly as heard", logged.transcript.includes("bees aam"), logged);
  ok("with the engine that heard it", logged.engine === "whisper", logged.engine);
  ok("and the confidence it reported", logged.noSpeechProb === 0.04, logged.noSpeechProb);
  ok("not saved until something is actually written", logged.saved === false, logged.saved);

  await markVoiceAttemptSaved(attemptId!);
  const after = await prisma.voiceAttempt.findUniqueOrThrow({ where: { id: attemptId! } });
  ok("marking it saved is what records the verdict", after.saved === true, after.saved);

  // A runaway recording is not a command, and the column should not carry one.
  const longId = await logVoiceAttempt({
    transcript: "x".repeat(2000),
    engine: "browser",
    language: "unknown",
    kind: "unknown",
  });
  const long = await prisma.voiceAttempt.findUniqueOrThrow({ where: { id: longId! } });
  ok("a runaway transcript is capped", long.transcript.length === 500, long.transcript.length);

  // The whole point of the try/catch in there: a command must not fail because
  // the log did. Marking an id that does not exist is the cheapest way to
  // provoke the failure path.
  let threw = false;
  try {
    await markVoiceAttemptSaved(-1);
  } catch {
    threw = true;
  }
  ok("a log failure never becomes the command's failure", !threw);

  await prisma.voiceAttempt.deleteMany({ where: { id: { in: [attemptId!, longId!] } } });

  console.log(`\n${checks - failures}/${checks} recognition checks passed`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
