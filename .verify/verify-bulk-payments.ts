/**
 * Clearing every outstanding invoice at once.
 *
 * This is the only action in the app that writes money across the whole
 * business in one press, so what is checked here is mostly the ways that could
 * go wrong quietly: a partly-paid invoice being charged its full value again, a
 * second press doubling the money, an undo that takes back payments it did not
 * record, and the two figures - stock and revenue - that a payment must never
 * move no matter how many of them there are.
 */
import { prisma } from "@/lib/db";
import { emptyActionState } from "@/lib/validations";
import { createBatchAction } from "@/actions/batches";
import { createBookingAction } from "@/actions/bookings";
import { recordPaymentAction } from "@/actions/payments";
import {
  clearAllReceivablesAction,
  getLastClearance,
  previewClearAllAction,
  undoClearanceAction,
} from "@/actions/bulk-payments";
import { getBookingBalance, getReceivables } from "@/lib/bookings";
import { getKpis, getStockLevels } from "@/lib/queries";

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

const YEAR = 2026;
const DATE = `${YEAR}-05-10`;
const PAID_ON = `${YEAR}-05-20`;
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

async function main() {
  section("nothing outstanding");
  const empty = await previewClearAllAction();
  ok("preview counts nothing", empty.invoices === 0, empty);
  const onEmpty = await clearAllReceivablesAction(
    emptyActionState,
    fd({ paidOn: PAID_ON, confirmCount: "0" }),
  );
  ok("clearing says so rather than failing", onEmpty.ok, onEmpty);
  ok("and no payments exist", (await prisma.payment.count()) === 0);

  /* ------------------------------------------------------------- fixtures */
  const product = await prisma.product.findUniqueOrThrow({ where: { sku: "MNG-BTL-250" } });
  const area = await prisma.area.findFirstOrThrow({ where: { name: "Downtown" } });
  const shop = await prisma.shop.findFirstOrThrow({ where: { name: "Central Mart" } });

  await createBatchAction(
    emptyActionState,
    fd({
      productId: String(product.id),
      quantity: "1000",
      unitCost: "200",
      receivedDate: `${YEAR}-01-05`,
      idempotencyKey: "bulk-batch",
    }),
  );

  /** Three invoices: 45,000 / 22,500 / 9,000. */
  const values = [
    { qty: 100, price: 450, key: "bulk-b1" },
    { qty: 50, price: 450, key: "bulk-b2" },
    { qty: 20, price: 450, key: "bulk-b3" },
  ];
  for (const v of values) {
    await createBookingAction(
      emptyActionState,
      fd({
        customerName: `Buyer ${v.key}`,
        areaId: String(area.id),
        shopId: String(shop.id),
        bookingDate: DATE,
        lines: JSON.stringify([{ productId: product.id, quantity: v.qty, unitPrice: v.price }]),
        idempotencyKey: v.key,
      }),
    );
  }
  const bookings = await Promise.all(
    values.map((v) => prisma.booking.findFirstOrThrow({ where: { idempotencyKey: v.key } })),
  );
  const INVOICED = 45000 + 22500 + 9000;

  // One is part-paid, which is the case a bulk clearance is most likely to get
  // wrong: it must settle what REMAINS, not what the invoice was worth.
  await recordPaymentAction(
    emptyActionState,
    fd({
      bookingId: String(bookings[1]!.id),
      amount: "2500",
      paidOn: `${YEAR}-05-15`,
      idempotencyKey: "bulk-partial",
    }),
  );
  const OUTSTANDING = INVOICED - 2500;

  section("the preview");
  const preview = await previewClearAllAction();
  ok("counts every unpaid invoice", preview.invoices === 3, preview);
  ok("totals the remaining balances, not the invoice values", near(preview.total, OUTSTANDING), preview);

  const kpisBefore = await getKpis({ year: YEAR, categoryId: null, areaId: null });
  const stockBefore = await getStockLevels();

  section("the count has to agree");
  const wrong = await clearAllReceivablesAction(
    emptyActionState,
    fd({ paidOn: PAID_ON, confirmCount: "2" }),
  );
  ok("a count that does not match is refused", !wrong.ok, wrong);
  ok("and nothing was written", (await prisma.payment.count({ where: { isDeleted: false } })) === 1);

  const badDate = await clearAllReceivablesAction(
    emptyActionState,
    fd({ paidOn: "", confirmCount: "3" }),
  );
  ok("a missing date is refused", !badDate.ok, badDate);

  section("clearing");
  const cleared = await clearAllReceivablesAction(
    emptyActionState,
    fd({ paidOn: PAID_ON, method: "Cash", confirmCount: "3" }),
  );
  ok("it succeeds", cleared.ok, cleared);

  const balances = await Promise.all(bookings.map((b) => getBookingBalance(b.id)));
  ok("every invoice is settled", balances.every((b) => b !== null && near(b.balance, 0)), balances);
  ok("and reads as paid", balances.every((b) => b?.status === "paid"), balances.map((b) => b?.status));
  ok(
    "the part-paid invoice was charged only what remained",
    near(
      Number(
        (
          await prisma.payment.findFirstOrThrow({
            where: { bookingId: bookings[1]!.id, idempotencyKey: { startsWith: "bulk:" } },
          })
        ).amount,
      ),
      20000,
    ),
  );

  const after = await getReceivables();
  ok("receivables is empty", after.rows.filter((r) => r.balance > 0.005).length === 0);

  section("what a payment must never move");
  const kpisAfter = await getKpis({ year: YEAR, categoryId: null, areaId: null });
  ok("revenue is unchanged", near(kpisBefore.year.revenue, kpisAfter.year.revenue), [
    kpisBefore.year.revenue,
    kpisAfter.year.revenue,
  ]);
  ok("profit is unchanged", near(kpisBefore.year.profit, kpisAfter.year.profit));
  const stockAfter = await getStockLevels();
  ok(
    "stock is unchanged",
    stockBefore.find((s) => s.sku === "MNG-BTL-250")!.currentStock ===
      stockAfter.find((s) => s.sku === "MNG-BTL-250")!.currentStock,
  );

  section("pressing it again");
  const again = await clearAllReceivablesAction(
    emptyActionState,
    fd({ paidOn: PAID_ON, confirmCount: "3" }),
  );
  ok("says there is nothing to do", again.ok, again);
  ok(
    "and does not double the money",
    (await prisma.payment.count({ where: { isDeleted: false } })) === 4,
    await prisma.payment.count({ where: { isDeleted: false } }),
  );

  section("undo");
  const last = await getLastClearance();
  ok("the run can be found", last !== null && last.invoices === 3, last);
  ok("and reports what it took", last !== null && near(last.total, OUTSTANDING), last);

  const undone = await undoClearanceAction(emptyActionState, fd({ batchId: last!.batchId }));
  ok("it succeeds", undone.ok, undone);

  const backBalances = await Promise.all(bookings.map((b) => getBookingBalance(b.id)));
  ok(
    "every invoice is outstanding again",
    backBalances.every((b) => b !== null && b.balance > 0.005),
    backBalances.map((b) => b?.balance),
  );
  ok(
    "the hand-recorded payment was NOT taken back",
    near(backBalances[1]!.paid, 2500),
    backBalances[1],
  );
  ok(
    "the outstanding total is what it was before the clearance",
    near(
      backBalances.reduce((s, b) => s + (b?.balance ?? 0), 0),
      OUTSTANDING,
    ),
  );

  const twice = await undoClearanceAction(emptyActionState, fd({ batchId: last!.batchId }));
  ok("undoing the same run twice is refused", !twice.ok, twice);

  ok(
    "the reversed rows are kept, not deleted",
    (await prisma.payment.count({ where: { isDeleted: true } })) === 3,
  );

  console.log(`\n${checks - failures}/${checks} bulk payment checks passed`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
