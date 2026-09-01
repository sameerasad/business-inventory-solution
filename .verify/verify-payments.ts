/**
 * Payment tracking: instalments, derived status, receivables, and the guarantee
 * that payments never move stock or revenue.
 */
import { prisma } from "@/lib/db";
import { emptyActionState } from "@/lib/validations";
import { createBatchAction } from "@/actions/batches";
import { createBookingAction } from "@/actions/bookings";
import {
  deletePaymentAction,
  getPaymentDetails,
  recordPaymentAction,
} from "@/actions/payments";
import {
  getBookingBalance,
  getBookingList,
  getInvoice,
  getReceivables,
  paymentStatus,
} from "@/lib/bookings";
import { getKpis, getStockLevels } from "@/lib/queries";
import { renderInvoicePdf } from "@/lib/invoice-pdf";
import { pdfText } from "./pdf-text";

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

async function main() {
  section("pure status derivation");
  ok("nothing paid is unpaid", paymentStatus(1000, 0) === "unpaid");
  ok("some paid is partial", paymentStatus(1000, 400) === "partial");
  ok("all paid is paid", paymentStatus(1000, 1000) === "paid");
  ok("a paisa short is still partial", paymentStatus(1000, 999.99) === "partial");
  ok("rounding noise counts as paid", paymentStatus(1000, 999.998) === "paid");
  ok("overpaid still reads paid", paymentStatus(1000, 1200) === "paid");
  ok("a zero-value order reads paid, not unpaid", paymentStatus(0, 0) === "paid");

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
      idempotencyKey: "pay-batch",
    }),
  );

  // 100 x 450 = 45,000
  const booked = await createBookingAction(
    emptyActionState,
    fd({
      customerName: "Credit Buyer",
      customerPhone: "0300-1112223",
      areaId: String(area.id),
      shopId: String(shop.id),
      bookingDate: DATE,
      lines: JSON.stringify([{ productId: product.id, quantity: 100, unitPrice: 450 }]),
      idempotencyKey: "pay-booking",
    }),
  );
  ok("booking created", booked.ok, booked);
  const booking = await prisma.booking.findFirstOrThrow({
    where: { idempotencyKey: "pay-booking" },
  });
  const TOTAL = 45000;

  section("a delivered but unpaid order");
  const b0 = await getBookingBalance(booking.id);
  ok("total is the sale value", b0 !== null && Math.abs(b0.total - TOTAL) < 0.005, b0);
  ok("nothing paid yet", b0 !== null && b0.paid === 0, b0);
  ok("whole amount outstanding", b0 !== null && Math.abs(b0.balance - TOTAL) < 0.005, b0);
  ok("status is unpaid", b0?.status === "unpaid", b0?.status);

  // The point of the design: unpaid does NOT mean unsold.
  const stockAfterBooking = await getStockLevels();
  ok(
    "stock already went out despite no payment",
    stockAfterBooking.find((s) => s.sku === "MNG-BTL-250")!.currentStock === 900,
    stockAfterBooking.find((s) => s.sku === "MNG-BTL-250")!.currentStock,
  );
  const kpisUnpaid = await getKpis({ year: YEAR, categoryId: null, areaId: null });
  ok(
    "revenue counts on delivery, not on payment",
    Math.abs(kpisUnpaid.year.revenue - TOTAL) < 0.005,
    kpisUnpaid.year.revenue,
  );
  ok(
    "profit counts too: 100 x (450 - 200) = 25000",
    Math.abs(kpisUnpaid.year.profit - 25000) < 0.005,
    kpisUnpaid.year.profit,
  );

  section("receivables picks it up");
  const r0 = await getReceivables();
  ok("one outstanding invoice", r0.rows.length === 1, r0.rows.length);
  ok("outstanding equals the total", Math.abs(r0.totals.outstanding - TOTAL) < 0.005, r0.totals);
  ok("collected is zero", r0.totals.collected === 0, r0.totals.collected);
  ok("invoiced equals the total", Math.abs(r0.totals.invoiced - TOTAL) < 0.005, r0.totals);
  ok("aging buckets sum to the outstanding total",
    Math.abs(r0.buckets.reduce((s, b) => s + b.amount, 0) - TOTAL) < 0.005,
    r0.buckets);

  section("first instalment: partial");
  const p1 = await recordPaymentAction(
    emptyActionState,
    fd({
      bookingId: String(booking.id),
      amount: "20000",
      paidOn: `${YEAR}-05-15`,
      method: "Cash",
      idempotencyKey: "pay-1",
    }),
  );
  ok("payment recorded", p1.ok, p1);
  ok("message reports the remaining balance", (p1.message ?? "").includes("25000"), p1.message);
  const b1 = await getBookingBalance(booking.id);
  ok("paid is 20000", b1 !== null && Math.abs(b1.paid - 20000) < 0.005, b1);
  ok("balance is 25000", b1 !== null && Math.abs(b1.balance - 25000) < 0.005, b1);
  ok("status is partial", b1?.status === "partial", b1?.status);

  // The whole reason payments are separate from sales.
  const stockAfterPayment = await getStockLevels();
  ok(
    "a payment does not move stock",
    stockAfterPayment.find((s) => s.sku === "MNG-BTL-250")!.currentStock === 900,
  );
  const kpisAfterPayment = await getKpis({ year: YEAR, categoryId: null, areaId: null });
  ok(
    "a payment does not change revenue",
    Math.abs(kpisAfterPayment.year.revenue - TOTAL) < 0.005,
    kpisAfterPayment.year.revenue,
  );
  ok(
    "a payment does not change profit",
    Math.abs(kpisAfterPayment.year.profit - 25000) < 0.005,
    kpisAfterPayment.year.profit,
  );

  section("overpayment is refused");
  const over = await recordPaymentAction(
    emptyActionState,
    fd({
      bookingId: String(booking.id),
      amount: "99999",
      paidOn: `${YEAR}-05-16`,
      idempotencyKey: "pay-over",
    }),
  );
  ok("more than the balance is rejected", !over.ok, over);
  ok("the error names the balance", (over.message ?? "").includes("25000"), over.message);
  const bAfterOver = await getBookingBalance(booking.id);
  ok("nothing was recorded", bAfterOver !== null && Math.abs(bAfterOver.paid - 20000) < 0.005, bAfterOver);

  section("validation");
  const zero = await recordPaymentAction(
    emptyActionState,
    fd({ bookingId: String(booking.id), amount: "0", paidOn: DATE }),
  );
  ok("a zero payment is rejected", !zero.ok, zero);
  const badDate = await recordPaymentAction(
    emptyActionState,
    fd({ bookingId: String(booking.id), amount: "10", paidOn: "not-a-date" }),
  );
  ok("a bad date is rejected", !badDate.ok && !!badDate.fieldErrors.paidOn, badDate.fieldErrors);
  const noBooking = await recordPaymentAction(
    emptyActionState,
    fd({ bookingId: "999999", amount: "10", paidOn: DATE }),
  );
  ok("an unknown booking is rejected", !noBooking.ok, noBooking);

  section("idempotency");
  const replay = await recordPaymentAction(
    emptyActionState,
    fd({
      bookingId: String(booking.id),
      amount: "20000",
      paidOn: `${YEAR}-05-15`,
      idempotencyKey: "pay-1",
    }),
  );
  ok("replay reports success", replay.ok, replay);
  const bReplay = await getBookingBalance(booking.id);
  ok("the money was not taken twice", bReplay !== null && Math.abs(bReplay.paid - 20000) < 0.005, bReplay);

  section("settling the balance");
  const p2 = await recordPaymentAction(
    emptyActionState,
    fd({
      bookingId: String(booking.id),
      amount: "25000",
      paidOn: `${YEAR}-06-01`,
      method: "Bank transfer",
      idempotencyKey: "pay-2",
    }),
  );
  ok("second instalment recorded", p2.ok, p2);
  ok("message says fully paid", (p2.message ?? "").toLowerCase().includes("fully paid"), p2.message);
  const b2 = await getBookingBalance(booking.id);
  ok("balance is zero", b2 !== null && b2.balance < 0.005, b2);
  ok("status is paid", b2?.status === "paid", b2?.status);

  const details = await getPaymentDetails(booking.id);
  ok("two instalments in the history", details?.payments.length === 2, details?.payments.length);
  ok(
    "history is oldest first",
    details !== null &&
      details.payments[0].paidOn.toISOString().slice(0, 10) === `${YEAR}-05-15` &&
      details.payments[1].paidOn.toISOString().slice(0, 10) === `${YEAR}-06-01`,
    details?.payments.map((p) => p.paidOn),
  );
  ok(
    "methods are kept",
    details?.payments[0].method === "Cash" && details?.payments[1].method === "Bank transfer",
    details?.payments.map((p) => p.method),
  );

  const r1 = await getReceivables();
  ok("nothing outstanding now", r1.rows.length === 0, r1.rows.length);
  ok("collected is the full total", Math.abs(r1.totals.collected - TOTAL) < 0.005, r1.totals);

  section("the invoice shows paid and balance");
  const invoice = await getInvoice(booking.id);
  ok("invoice paid is the full total", invoice !== null && Math.abs(invoice.paid - TOTAL) < 0.005, invoice?.paid);
  ok("invoice balance is zero", invoice !== null && invoice.balance < 0.005, invoice?.balance);
  const paidPdf = pdfText(await renderInvoicePdf(invoice!));
  ok('a settled invoice says "PAID IN FULL"', paidPdf.includes("PAID IN FULL"), paidPdf.slice(0, 200));
  ok("still no cost or profit wording", !/\b(cost|profit|margin)\b/i.test(paidPdf));

  section("reversing a payment");
  const firstPayment = details!.payments[0];
  const rev = await deletePaymentAction(
    emptyActionState,
    fd({ id: String(firstPayment.id), reason: "cheque bounced" }),
  );
  ok("payment reversed", rev.ok, rev);
  const b3 = await getBookingBalance(booking.id);
  ok("balance is owed again", b3 !== null && Math.abs(b3.balance - 20000) < 0.005, b3);
  ok("status back to partial", b3?.status === "partial", b3?.status);
  ok(
    "the reversed row is kept, not erased",
    (await prisma.payment.findUniqueOrThrow({ where: { id: firstPayment.id } })).isDeleted === true,
  );
  const r2 = await getReceivables();
  ok("it reappears in receivables", r2.rows.length === 1, r2.rows.length);
  ok(
    "outstanding is the reversed amount",
    Math.abs(r2.totals.outstanding - 20000) < 0.005,
    r2.totals,
  );

  const unpaidInvoice = await getInvoice(booking.id);
  const partPdf = pdfText(await renderInvoicePdf(unpaidInvoice!));
  ok('a part-paid invoice says "BALANCE DUE"', partPdf.includes("BALANCE DUE"), partPdf.slice(0, 200));

  section("bookings list carries the money picture");
  const list = await getBookingList({ from: null, to: null, areaId: null, q: null, page: 1 });
  const row = list.rows.find((r) => r.id === booking.id)!;
  ok("row total", Math.abs(row.total - TOTAL) < 0.005, row.total);
  ok("row paid", Math.abs(row.paid - 25000) < 0.005, row.paid);
  ok("row balance", Math.abs(row.balance - 20000) < 0.005, row.balance);
  ok("filtered collected total", Math.abs(list.totals.collected - 25000) < 0.005, list.totals);

  section("a cancelled booking takes no payment");
  const { softDeleteBookingAction } = await import("@/actions/bookings");
  await softDeleteBookingAction(emptyActionState, fd({ id: String(booking.id) }));
  const afterCancel = await recordPaymentAction(
    emptyActionState,
    fd({
      bookingId: String(booking.id),
      amount: "100",
      paidOn: DATE,
      idempotencyKey: "pay-cancelled",
    }),
  );
  ok("payment on a cancelled booking is refused", !afterCancel.ok, afterCancel);
  const r3 = await getReceivables();
  ok("a cancelled booking leaves receivables", r3.rows.length === 0, r3.rows.length);

  console.log(`\n${checks - failures}/${checks} payment checks passed`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
