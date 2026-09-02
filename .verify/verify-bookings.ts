/**
 * Bookings + invoice PDF, checked against a real Postgres.
 * Run via .verify/tsconfig.verify.json so next/cache is stubbed.
 */
import { prisma } from "@/lib/db";
import { emptyActionState } from "@/lib/validations";
import { createBatchAction } from "@/actions/batches";
import { createBookingAction, softDeleteBookingAction } from "@/actions/bookings";
import { createShop } from "@/actions/areas";
import { getInvoiceShareData, getInvoiceShareToken } from "@/actions/bookings";
import { getBookingList, getBookableProducts, getInvoice } from "@/lib/bookings";
import { getKpis, getStockLevels } from "@/lib/queries";
import { renderInvoicePdf, invoiceFileName } from "@/lib/invoice-pdf";
import { yearRange } from "@/lib/dates";
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
const DATE = `${YEAR}-04-10`;

async function main() {
  const mango = await prisma.product.findUniqueOrThrow({ where: { sku: "MNG-BTL-250" } });
  const apple = await prisma.product.findUniqueOrThrow({ where: { sku: "APP-TET-500" } });
  const choco = await prisma.product.findUniqueOrThrow({ where: { sku: "CHO-BAR-10" } });
  const area = await prisma.area.findFirstOrThrow({ where: { name: "Downtown" } });
  const shop = await prisma.shop.findFirstOrThrow({ where: { name: "Central Mart" } });

  section("shop address is stored on the shop record");
  const addr = await createShop({
    areaId: area.id,
    name: shop.name,
    address: "Shop 12, Block C, Jinnah Road, Gulberg III, Lahore",
  });
  ok("address saved onto the existing shop", addr.ok, addr);
  const withAddr = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
  ok(
    "address persisted",
    withAddr.address === "Shop 12, Block C, Jinnah Road, Gulberg III, Lahore",
    withAddr.address,
  );
  // Re-adding the same shop without an address must not blank the saved one.
  const noBlank = await createShop({ areaId: area.id, name: shop.name });
  const stillThere = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
  ok("re-adding a shop with no address does not blank it", noBlank.ok && stillThere.address !== null, stillThere.address);

  section("stock: two mango batches at different costs (to force a split)");
  // 100 @ 40 then 100 @ 50. A 150-unit line must span both.
  for (const [i, [qty2, cost, date]] of (
    [
      [100, "40", `${YEAR}-01-05`],
      [100, "50", `${YEAR}-02-05`],
    ] as [number, string, string][]
  ).entries()) {
    const r = await createBatchAction(
      emptyActionState,
      fd({
        productId: String(mango.id),
        quantity: String(qty2),
        unitCost: cost,
        receivedDate: date,
        idempotencyKey: `bk-mango-${i}`,
      }),
    );
    ok(`mango batch ${i + 1} received (${qty2} @ ${cost})`, r.ok, r);
  }
  for (const [pid, sku, q, c] of [
    [apple.id, "apple", 500, "70"],
    [choco.id, "choco", 1000, "6"],
  ] as [number, string, number, string][]) {
    const r = await createBatchAction(
      emptyActionState,
      fd({
        productId: String(pid),
        quantity: String(q),
        unitCost: c,
        receivedDate: `${YEAR}-03-01`,
        idempotencyKey: `bk-${sku}`,
      }),
    );
    ok(`${sku} batch received`, r.ok, r);
  }

  section("bookable products expose availability");
  const bookable = await getBookableProducts();
  const mangoAvail = bookable.find((p) => p.sku === "MNG-BTL-250")!;
  ok("mango shows 200 available across 2 batches", mangoAvail.available === 200, mangoAvail.available);
  ok("un-stocked product shows 0, not null", bookable.find((p) => p.sku === "PCH-BTL-500")!.available === 0);

  section("create a 3-line booking, one line spanning two batches");
  const lines = JSON.stringify([
    { productId: mango.id, quantity: 150, unitPrice: 100 }, // spans both mango batches
    { productId: apple.id, quantity: 40, unitPrice: 120 },
    { productId: choco.id, quantity: 200, unitPrice: 15 },
  ]);
  const booked = await createBookingAction(
    emptyActionState,
    fd({
      customerName: "Al-Madina Store",
      customerPhone: "0300-1234567",
      areaId: String(area.id),
      shopId: String(shop.id),
      bookingDate: DATE,
      notes: "Deliver before Friday. Payment on delivery.",
      lines,
      idempotencyKey: "booking-1",
    }),
  );
  ok("booking created", booked.ok, booked);

  const booking = await prisma.booking.findFirstOrThrow({
    where: { idempotencyKey: "booking-1" },
  });
  ok("invoice number formatted INV-YYYY-NNNNN", /^INV-2026-\d{5}$/.test(booking.invoiceNo), booking.invoiceNo);

  section("sales were captured automatically");
  const sales = await prisma.sale.findMany({
    where: { bookingId: booking.id },
    include: { batch: { select: { unitCost: true } }, product: { select: { sku: true } } },
    orderBy: { id: "asc" },
  });
  // mango splits into 2 rows, apple 1, choco 1 => 4 sale rows for 3 lines.
  ok("4 sale rows for 3 lines (mango split across batches)", sales.length === 4, sales.length);
  const mangoSales = sales.filter((s) => s.product.sku === "MNG-BTL-250");
  ok("mango split into 2 rows", mangoSales.length === 2, mangoSales.length);
  ok(
    "FIFO: 100 from the older batch then 50 from the newer",
    mangoSales[0].quantity === 100 && mangoSales[1].quantity === 50,
    mangoSales.map((s) => s.quantity),
  );
  ok(
    "each split row kept its own batch cost (40 then 50)",
    Number(mangoSales[0].batch.unitCost) === 40 && Number(mangoSales[1].batch.unitCost) === 50,
    mangoSales.map((s) => Number(s.batch.unitCost)),
  );
  ok(
    "every sale row carries the booked unit price",
    mangoSales.every((s) => Number(s.salePrice) === 100),
  );
  ok("sales inherit the area and shop", sales.every((s) => s.areaId === area.id && s.shopId === shop.id));
  ok("sale date is the booking date", sales.every((s) => s.saleDate.toISOString().slice(0, 10) === DATE));

  section("stock was deducted");
  const stock = await getStockLevels();
  ok("mango 200 - 150 = 50 left", stock.find((s) => s.sku === "MNG-BTL-250")!.currentStock === 50);
  ok("apple 500 - 40 = 460 left", stock.find((s) => s.sku === "APP-TET-500")!.currentStock === 460);
  ok("choco 1000 - 200 = 800 left", stock.find((s) => s.sku === "CHO-BAR-10")!.currentStock === 800);
  const olderBatch = await prisma.batch.findFirstOrThrow({ where: { idempotencyKey: "bk-mango-0" } });
  ok("older mango batch fully drained", olderBatch.remainingQty === 0, olderBatch.remainingQty);

  section("profit is exact across the batch split");
  //   mango: 100*(100-40) + 50*(100-50) = 6000 + 2500 = 8500
  //   apple:  40*(120-70)  = 2000
  //   choco: 200*(15-6)    = 1800
  const expectedProfit = 8500 + 2000 + 1800;
  //   revenue: 150*100 + 40*120 + 200*15 = 15000 + 4800 + 3000 = 22800
  const expectedRevenue = 22800;
  const kpis = await getKpis({ year: YEAR, categoryId: null, areaId: null });
  ok(`dashboard revenue = ${expectedRevenue}`, Math.abs(kpis.year.revenue - expectedRevenue) < 0.005, kpis.year.revenue);
  ok(
    `dashboard profit = ${expectedProfit} (weighted across both mango batches)`,
    Math.abs(kpis.year.profit - expectedProfit) < 0.005,
    kpis.year.profit,
  );

  section("bookings listing reconciles with the dashboard");
  const list = await getBookingList({ from: null, to: null, areaId: null, bookerId: null, q: null, page: 1 });
  ok("1 booking listed", list.total === 1, list.total);
  const row = list.rows[0];
  ok("listed total matches the order value", Math.abs(row.total - expectedRevenue) < 0.005, row.total);
  ok("listed profit matches the dashboard", Math.abs(row.profit - expectedProfit) < 0.005, row.profit);
  ok("line count counts 3 lines, not 4 sale rows", row.lineCount === 3, row.lineCount);
  ok("units = 390", row.units === 390, row.units);

  section("invoice content");
  const invoice = await getInvoice(booking.id);
  ok("invoice found", invoice !== null);
  if (!invoice) throw new Error("no invoice");
  ok("3 invoice lines (batch split collapsed back)", invoice.lines.length === 3, invoice.lines.length);
  const mangoLine = invoice.lines.find((l) => l.sku === "MNG-BTL-250")!;
  ok("mango line shows 150, not 100 + 50", mangoLine.quantity === 150, mangoLine.quantity);
  ok("mango line total = 15000", Math.abs(mangoLine.lineTotal - 15000) < 0.005, mangoLine.lineTotal);
  ok("invoice subtotal matches the order", Math.abs(invoice.subtotal - expectedRevenue) < 0.005, invoice.subtotal);
  ok("invoice total units = 390", invoice.totalUnits === 390, invoice.totalUnits);
  ok("customer details on the invoice", invoice.customerName === "Al-Madina Store" && invoice.customerPhone === "0300-1234567");
  ok("area and shop on the invoice", invoice.areaName === "Downtown" && invoice.shopName === "Central Mart");
  ok(
    "shop address reaches the invoice from the shop record",
    invoice.shopAddress === "Shop 12, Block C, Jinnah Road, Gulberg III, Lahore",
    invoice.shopAddress,
  );
  // The invoice is a customer document: it must not leak cost or profit.
  const serialised = JSON.stringify(invoice);
  ok("invoice carries NO unit cost field", !serialised.includes("unitCost"), serialised.slice(0, 120));
  ok("invoice carries NO profit field", !serialised.toLowerCase().includes("profit"));

  section("invoice PDF");
  const pdf = await renderInvoicePdf(invoice);
  const header = Buffer.from(pdf.slice(0, 5)).toString("latin1");
  ok("output is a real PDF (%PDF- magic bytes)", header === "%PDF-", header);
  ok("PDF is a sensible size (>2KB)", pdf.byteLength > 2048, pdf.byteLength);
  const body = Buffer.from(pdf).toString("latin1");
  ok("PDF has an EOF marker", body.trimEnd().endsWith("%%EOF"));
  const pdfBody = pdfText(pdf);

  // The QTY column must read "150 packs", not "150 bottle".
  const qtyCells: string[] = pdfBody.match(/^\d[\d,]* [a-z_]+$/gm) ?? [];
  ok("QTY column bills in packs", qtyCells.includes("150 packs"), qtyCells);
  ok(
    "no QTY cell uses an internal product unit",
    qtyCells.length > 0 && qtyCells.every((c) => /\bpacks?$/.test(c)),
    qtyCells,
  );
  ok("totals row says Total packs", pdfBody.includes("Total packs"), pdfBody.slice(0, 80));
  ok(
    "shop address is printed on the PDF",
    pdfBody.includes("Shop 12, Block C, Jinnah Road,") || pdfBody.includes("Jinnah Road,"),
    pdfBody.split(String.fromCharCode(10)).slice(0, 14),
  );
  ok(
    "customer-facing PDF leaks no cost or profit wording",
    !/\b(cost|profit|margin)\b/i.test(pdfBody),
    pdfBody.match(/\b(cost|profit|margin)\b/gi),
  );

  ok(
    "filename is safe and named after the invoice",
    /^INV-2026-\d{5}-Al-Madina-Store\.pdf$/.test(invoiceFileName(invoice)),
    invoiceFileName(invoice),
  );

  section("shareable invoice link");
  const token = await getInvoiceShareToken(booking.id);
  ok("a share token exists", typeof token === "string" && token.length >= 20, token);
  ok(
    "token is url-safe and unguessable-looking",
    token !== null && /^[A-Za-z0-9_-]{20,}$/.test(token),
    token,
  );
  // NOT "does the token contain the id's digits" - a random 22-character string
  // contains "1" about half the time, which made this test flaky rather than
  // meaningful. What matters is that it is not the id and carries real entropy.
  ok("token is not just the id", token !== String(booking.id), token);
  ok(
    "token has high character diversity",
    token !== null && new Set(token).size >= 12,
    token === null ? null : new Set(token).size,
  );
  const tokenAgain = await getInvoiceShareToken(booking.id);
  ok("asking twice returns the same token", tokenAgain === token, { token, tokenAgain });

  const shareData = await getInvoiceShareData(booking.id);
  ok("share data found", shareData !== null);
  ok(
    "share data carries the invoice number and lines",
    shareData !== null && shareData.invoiceNo === booking.invoiceNo && shareData.lines.length === 3,
    shareData?.lines.length,
  );
  ok(
    "share total matches the invoice",
    shareData !== null && Math.abs(shareData.total - expectedRevenue) < 0.005,
    shareData?.total,
  );
  // The WhatsApp text is a customer document too.
  ok(
    "share data leaks no cost or profit",
    !/(cost|profit|margin)/i.test(JSON.stringify(shareData)),
    JSON.stringify(shareData).slice(0, 120),
  );
  ok("unknown booking has no token", (await getInvoiceShareToken(999999)) === null);
  ok("invalid id is rejected", (await getInvoiceShareToken(-1)) === null);

  section("idempotency: a double submit must not sell twice");
  const replay = await createBookingAction(
    emptyActionState,
    fd({
      customerName: "Al-Madina Store",
      areaId: String(area.id),
      bookingDate: DATE,
      lines,
      idempotencyKey: "booking-1",
    }),
  );
  ok("replay reports success", replay.ok, replay);
  ok("still only 1 booking", (await prisma.booking.count()) === 1);
  ok("still only 4 sale rows", (await prisma.sale.count()) === 4);
  ok(
    "stock unchanged by the replay",
    (await getStockLevels()).find((s) => s.sku === "MNG-BTL-250")!.currentStock === 50,
  );

  section("short stock aborts the WHOLE order (nothing partially written)");
  const before = await getStockLevels();
  const shortLines = JSON.stringify([
    { productId: choco.id, quantity: 10, unitPrice: 15 }, // fine
    { productId: mango.id, quantity: 9999, unitPrice: 100 }, // impossible
  ]);
  const short = await createBookingAction(
    emptyActionState,
    fd({
      customerName: "Overreach Traders",
      areaId: String(area.id),
      bookingDate: DATE,
      lines: shortLines,
      idempotencyKey: "booking-short",
    }),
  );
  ok("short order rejected", !short.ok, short);
  ok("message names the SKU and what is available", (short.message ?? "").includes("MNG-BTL-250") && (short.message ?? "").includes("50"), short.message);
  const after = await getStockLevels();
  ok(
    "the good line was NOT written - choco stock unchanged",
    after.find((s) => s.sku === "CHO-BAR-10")!.currentStock ===
      before.find((s) => s.sku === "CHO-BAR-10")!.currentStock,
    { before: before.find((s) => s.sku === "CHO-BAR-10")!.currentStock, after: after.find((s) => s.sku === "CHO-BAR-10")!.currentStock },
  );
  ok("no orphan booking row", (await prisma.booking.count()) === 1);
  ok("no orphan sale rows", (await prisma.sale.count()) === 4);

  section("validation");
  const noLines = await createBookingAction(
    emptyActionState,
    fd({ customerName: "X", areaId: String(area.id), bookingDate: DATE, lines: "[]" }),
  );
  ok("empty order rejected", !noLines.ok, noLines);
  // A walk-in with no name is allowed.
  const noCustomer = await createBookingAction(
    emptyActionState,
    fd({
      customerName: "",
      areaId: String(area.id),
      bookingDate: DATE,
      lines: JSON.stringify([{ productId: choco.id, quantity: 3, unitPrice: 15 }]),
      idempotencyKey: "booking-noname",
    }),
  );
  ok("booking with no customer name is accepted", noCustomer.ok, noCustomer);
  const walkInNoName = await prisma.booking.findFirstOrThrow({
    where: { idempotencyKey: "booking-noname" },
  });
  ok("customer name stored as null", walkInNoName.customerName === null, walkInNoName.customerName);
  const nonameInvoice = await getInvoice(walkInNoName.id);
  const nonamePdf = pdfText(await renderInvoicePdf(nonameInvoice!));
  ok(
    "invoice prints Walk-in customer instead of a blank BILL TO",
    nonamePdf.includes("Walk-in customer"),
    nonamePdf.split(String.fromCharCode(10)).slice(0, 8),
  );
  const badPrice = await createBookingAction(
    emptyActionState,
    fd({
      customerName: "Y",
      areaId: String(area.id),
      bookingDate: DATE,
      lines: JSON.stringify([{ productId: choco.id, quantity: 1, unitPrice: 1.234 }]),
    }),
  );
  ok("more than 2 decimals on price rejected", !badPrice.ok, badPrice);

  section("second booking gets the next invoice number");
  const second = await createBookingAction(
    emptyActionState,
    fd({
      customerName: "Walk-in Buyer",
      areaId: String(area.id),
      bookingDate: DATE,
      lines: JSON.stringify([{ productId: choco.id, quantity: 5, unitPrice: 15 }]),
      idempotencyKey: "booking-2",
    }),
  );
  ok("second booking created", second.ok, second);
  const two = await prisma.booking.findMany({ orderBy: { id: "asc" }, select: { invoiceNo: true } });
  ok(
    "invoice numbers are sequential",
    two[0].invoiceNo === "INV-2026-00001" && two[1].invoiceNo === "INV-2026-00002",
    two.map((b) => b.invoiceNo),
  );
  const walkIn = await prisma.booking.findFirstOrThrow({ where: { idempotencyKey: "booking-2" } });
  const walkInInvoice = await getInvoice(walkIn.id);
  ok("direct sale invoice says no shop", walkInInvoice!.shopName === null);
  const walkInToken = await getInvoiceShareToken(walkIn.id);
  ok("a second booking gets a different share token", walkInToken !== null && walkInToken !== token, {
    token,
    walkInToken,
  });
  const pdf2 = await renderInvoicePdf(walkInInvoice!);
  ok("single-line invoice PDF renders", Buffer.from(pdf2.slice(0, 5)).toString("latin1") === "%PDF-");

  section("cancelling a booking returns stock and stops counting");
  const cancel = await softDeleteBookingAction(
    emptyActionState,
    fd({ id: String(booking.id), reason: "customer cancelled" }),
  );
  ok("cancelled", cancel.ok, cancel);
  ok("message says how many units came back", (cancel.message ?? "").includes("390"), cancel.message);
  const restored = await getStockLevels();
  ok("mango back to 200", restored.find((s) => s.sku === "MNG-BTL-250")!.currentStock === 200);
  ok("apple back to 500", restored.find((s) => s.sku === "APP-TET-500")!.currentStock === 500);
  // 1000 received, less 5 (walk-in) and 3 (no-name walk-in) still on order.
  ok(
    "choco back to 992 (the two later bookings still hold 8)",
    restored.find((s) => s.sku === "CHO-BAR-10")!.currentStock === 992,
    restored.find((s) => s.sku === "CHO-BAR-10")!.currentStock,
  );
  const kpisAfter = await getKpis({ year: YEAR, categoryId: null, areaId: null });
  // Remaining revenue is the two walk-ins: 5x15 + 3x15 = 120.
  ok(
    "cancelled revenue drops out of the dashboard (only the 120 of walk-ins remains)",
    Math.abs(kpisAfter.year.revenue - 120) < 0.005,
    kpisAfter.year.revenue,
  );
  const listAfter = await getBookingList({ from: null, to: null, areaId: null, bookerId: null, q: null, page: 1 });
  ok("cancelled booking hidden from the list", listAfter.total === 2, listAfter.total);
  const cancelledInvoice = await getInvoice(booking.id);
  ok("cancelled booking still has an invoice record", cancelledInvoice !== null);
  ok("cancelled invoice is flagged", cancelledInvoice!.isDeleted === true);
  ok("cancelled invoice has no live lines", cancelledInvoice!.lines.length === 0, cancelledInvoice!.lines.length);
  const pdf3 = await renderInvoicePdf(cancelledInvoice!);
  ok("cancelled invoice still renders a PDF (watermarked)", Buffer.from(pdf3.slice(0, 5)).toString("latin1") === "%PDF-");

  section("audit trail");
  const created = await prisma.auditLog.findFirst({ where: { entityType: "booking", action: "booking.created" } });
  ok("booking creation audited", created != null);
  ok("audit payload records the lines", JSON.stringify(created?.payload).includes("MNG-BTL-250"));
  const cancelled = await prisma.auditLog.findFirst({ where: { entityType: "booking", action: "booking.cancelled" } });
  ok("cancellation audited", cancelled != null);

  // Silence the unused-import warning while keeping the helper available.
  void yearRange;

  console.log(`\n${checks - failures}/${checks} booking checks passed`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
