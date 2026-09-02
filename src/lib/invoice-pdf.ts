import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import type { Invoice } from "@/lib/bookings";
import { dateOnly, money, qty } from "@/lib/format";
import { business } from "@/lib/business";

/**
 * Renders an invoice to a real PDF.
 *
 * pdf-lib rather than a HTML-to-PDF renderer on purpose: it is pure JavaScript
 * with no headless browser and no font files to ship, so it runs unchanged in a
 * Vercel serverless function. The cost is manual layout, which is what most of
 * this file is.
 *
 * The document is customer-facing: it shows quantities, unit prices and totals,
 * and never unit cost or profit.
 */

/** Your own details, printed at the top. Same source as the site header. */
const seller = business;

/**
 * The invoice bills in packs, whatever the product record calls its unit
 * internally (bottle / tetra_pack / bar). Customers order and are invoiced by
 * the pack, so that is the word on the document.
 *
 * Product-level units are still what the Products, Batches and Sales pages show
 * - this is an invoice wording choice, not a change to how stock is counted.
 */
const PACK_LABEL = { one: "pack", many: "packs" } as const;

function packLabel(quantity: number): string {
  return quantity === 1 ? PACK_LABEL.one : PACK_LABEL.many;
}

/**
 * Who the invoice is addressed to. The customer name is optional - a cash or
 * walk-in sale often has none - but the BILL TO block must never be blank, so
 * it falls back to a neutral label.
 */
function billTo(invoice: Invoice): string {
  return invoice.customerName?.trim() || "Walk-in customer";
}

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 48;
const INK = rgb(0.05, 0.05, 0.05);
const MUTED = rgb(0.42, 0.42, 0.4);
const RULE = rgb(0.85, 0.85, 0.82);
const BAND = rgb(0.957, 0.961, 0.965);
const ACCENT = rgb(0.165, 0.471, 0.839);

type Ctx = {
  doc: PDFDocument;
  page: PDFPage;
  regular: PDFFont;
  bold: PDFFont;
  y: number;
};

/** Columns, as x offsets from the left margin. Right-aligned ones give their right edge. */
const COL = {
  sku: 0,
  description: 92,
  qty: 350,
  unitPrice: 430,
  total: A4.width - MARGIN * 2,
};

function text(
  ctx: Ctx,
  value: string,
  x: number,
  y: number,
  opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; align?: "left" | "right" } = {},
) {
  const size = opts.size ?? 9.5;
  const font = opts.bold ? ctx.bold : ctx.regular;
  const width = font.widthOfTextAtSize(value, size);
  ctx.page.drawText(value, {
    x: MARGIN + (opts.align === "right" ? x - width : x),
    y,
    size,
    font,
    color: opts.color ?? INK,
  });
}

function rule(ctx: Ctx, y: number, color = RULE) {
  ctx.page.drawLine({
    start: { x: MARGIN, y },
    end: { x: A4.width - MARGIN, y },
    thickness: 0.75,
    color,
  });
}

/**
 * pdf-lib has no text wrapping, so long descriptions and addresses are broken
 * into lines that fit the available width.
 */
function wrap(font: PDFFont, value: string, size: number, maxWidth: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let line = words[0];
  for (const word of words.slice(1)) {
    const candidate = `${line} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  return lines;
}

function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage([A4.width, A4.height]);
  ctx.y = A4.height - MARGIN;
}

function tableHeader(ctx: Ctx): void {
  ctx.page.drawRectangle({
    x: MARGIN,
    y: ctx.y - 16,
    width: A4.width - MARGIN * 2,
    height: 20,
    color: BAND,
  });
  const y = ctx.y - 10;
  text(ctx, "SKU", COL.sku + 6, y, { size: 8, bold: true, color: MUTED });
  text(ctx, "DESCRIPTION", COL.description, y, { size: 8, bold: true, color: MUTED });
  text(ctx, "QTY", COL.qty, y, { size: 8, bold: true, color: MUTED, align: "right" });
  text(ctx, "UNIT PRICE", COL.unitPrice, y, { size: 8, bold: true, color: MUTED, align: "right" });
  text(ctx, "AMOUNT", COL.total - 6, y, { size: 8, bold: true, color: MUTED, align: "right" });
  ctx.y -= 26;
}

export async function renderInvoicePdf(invoice: Invoice): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  doc.setTitle(`Invoice ${invoice.invoiceNo}`);
  doc.setSubject(`Invoice for ${billTo(invoice)}`);
  doc.setProducer("Inventory & Profit Tracking");
  doc.setCreationDate(invoice.createdAt);

  const ctx: Ctx = {
    doc,
    page: doc.addPage([A4.width, A4.height]),
    regular,
    bold,
    y: A4.height - MARGIN,
  };

  const biz = seller();
  const contentWidth = A4.width - MARGIN * 2;

  /* ------------------------------------------------------------ header */
  text(ctx, biz.name, 0, ctx.y - 4, { size: 16, bold: true });
  text(ctx, "INVOICE", COL.total, ctx.y - 2, { size: 20, bold: true, color: ACCENT, align: "right" });
  ctx.y -= 22;

  for (const line of [biz.address, biz.phone, biz.email, biz.taxId].filter(Boolean)) {
    for (const wrapped of wrap(regular, line, 8.5, 260)) {
      text(ctx, wrapped, 0, ctx.y, { size: 8.5, color: MUTED });
      ctx.y -= 11;
    }
  }

  // Invoice meta, right-aligned against the header block.
  let metaY = A4.height - MARGIN - 30;
  const meta: [string, string][] = [
    ["Invoice No", invoice.invoiceNo],
    ["Date", dateOnly(invoice.bookingDate)],
  ];
  for (const [label, value] of meta) {
    text(ctx, label, COL.total - 108, metaY, { size: 8.5, color: MUTED, align: "right" });
    text(ctx, value, COL.total, metaY, { size: 9.5, bold: true, align: "right" });
    metaY -= 13;
  }

  ctx.y = Math.min(ctx.y, metaY) - 10;
  rule(ctx, ctx.y);
  ctx.y -= 20;

  /* ------------------------------------------------- cancelled watermark */
  if (invoice.isDeleted) {
    ctx.page.drawText("CANCELLED", {
      x: 96,
      y: 380,
      size: 74,
      font: bold,
      color: rgb(0.85, 0.24, 0.24),
      opacity: 0.18,
      rotate: { type: "degrees", angle: 26 } as never,
    });
  }

  /* -------------------------------------------------------------- bill to */
  text(ctx, "BILL TO", 0, ctx.y, { size: 8, bold: true, color: MUTED });
  text(ctx, "DELIVERY AREA", 300, ctx.y, { size: 8, bold: true, color: MUTED });
  ctx.y -= 14;

  const billTop = ctx.y;
  text(ctx, billTo(invoice), 0, ctx.y, { size: 11, bold: true });
  let billY = ctx.y - 13;
  if (invoice.customerPhone) {
    text(ctx, invoice.customerPhone, 0, billY, { size: 9, color: MUTED });
    billY -= 11;
  }

  let areaY = billTop;
  text(ctx, invoice.areaName, 300, areaY, { size: 11, bold: true });
  areaY -= 13;
  text(ctx, invoice.shopName ?? "Direct sale (no shop)", 300, areaY, { size: 9, color: MUTED });
  areaY -= 11;
  // The shop's delivery address, stored once on the shop record.
  if (invoice.shopAddress) {
    for (const line of wrap(regular, invoice.shopAddress, 9, 200)) {
      text(ctx, line, 300, areaY, { size: 9, color: MUTED });
      areaY -= 11;
    }
  }

  ctx.y = Math.min(billY, areaY) - 14;

  /* --------------------------------------------------------------- lines */
  tableHeader(ctx);

  const rowFont = 9.5;
  for (const line of invoice.lines) {
    const descLines = wrap(regular, line.description, rowFont, COL.qty - COL.description - 20);
    const rowHeight = Math.max(18, 4 + descLines.length * 12);

    // Keep space for the totals block; break the page before it gets tight.
    if (ctx.y - rowHeight < MARGIN + 140) {
      newPage(ctx);
      tableHeader(ctx);
    }

    const baseY = ctx.y;
    text(ctx, line.sku, COL.sku + 6, baseY, { size: 8.5, color: MUTED });
    descLines.forEach((d, i) => {
      text(ctx, d, COL.description, baseY - i * 12, { size: rowFont });
    });
    text(ctx, `${qty(line.quantity)} ${packLabel(line.quantity)}`, COL.qty, baseY, {
      size: rowFont,
      align: "right",
    });
    text(ctx, money(line.unitPrice), COL.unitPrice, baseY, { size: rowFont, align: "right" });
    text(ctx, money(line.lineTotal), COL.total - 6, baseY, { size: rowFont, bold: true, align: "right" });

    ctx.y -= rowHeight;
    rule(ctx, ctx.y + 6);
  }

  /* -------------------------------------------------------------- totals */
  ctx.y -= 8;
  const totalsLeft = COL.total - 200;

  ctx.page.drawRectangle({
    x: MARGIN + totalsLeft,
    y: ctx.y - 42,
    width: 200,
    height: 46,
    color: BAND,
  });

  text(ctx, `Total ${PACK_LABEL.many}`, totalsLeft + 12, ctx.y - 12, { size: 9, color: MUTED });
  text(ctx, qty(invoice.totalUnits), COL.total - 12, ctx.y - 12, { size: 9, align: "right" });

  text(ctx, "TOTAL", totalsLeft + 12, ctx.y - 32, { size: 11, bold: true });
  text(ctx, money(invoice.subtotal), COL.total - 12, ctx.y - 32, {
    size: 13,
    bold: true,
    align: "right",
  });

  ctx.y -= 62;

  // Paid / Balance Due, but only when something has actually been paid - a
  // fully unpaid invoice does not need a "Paid: Rs 0" line.
  if (invoice.paid > 0.005) {
    ctx.page.drawRectangle({
      x: MARGIN + totalsLeft,
      y: ctx.y - 26,
      width: 200,
      height: 44,
      color: BAND,
    });
    text(ctx, "Paid", totalsLeft + 12, ctx.y + 4, { size: 9, color: MUTED });
    text(ctx, money(invoice.paid), COL.total - 12, ctx.y + 4, { size: 9, align: "right" });

    const settled = invoice.balance <= 0.005;
    text(ctx, settled ? "PAID IN FULL" : "BALANCE DUE", totalsLeft + 12, ctx.y - 16, {
      size: 10,
      bold: true,
      color: settled ? rgb(0, 0.39, 0) : rgb(0.82, 0.23, 0.23),
    });
    text(ctx, money(invoice.balance), COL.total - 12, ctx.y - 16, {
      size: 11,
      bold: true,
      align: "right",
      color: settled ? rgb(0, 0.39, 0) : rgb(0.82, 0.23, 0.23),
    });
    ctx.y -= 46;
  }

  /* --------------------------------------------------------------- notes */
  if (invoice.notes) {
    if (ctx.y < MARGIN + 70) newPage(ctx);
    text(ctx, "NOTES", 0, ctx.y, { size: 8, bold: true, color: MUTED });
    ctx.y -= 13;
    for (const line of wrap(regular, invoice.notes, 9, contentWidth - 20)) {
      text(ctx, line, 0, ctx.y, { size: 9, color: MUTED });
      ctx.y -= 11;
    }
  }

  /* -------------------------------------------------------------- footer */
  const footer = `${invoice.invoiceNo}  ·  booked by ${invoice.createdBy}  ·  generated ${dateOnly(new Date())}`;
  for (const page of doc.getPages()) {
    page.drawText(footer, {
      x: MARGIN,
      y: MARGIN - 18,
      size: 7.5,
      font: regular,
      color: MUTED,
    });
  }

  return doc.save();
}

/** Safe filename for the Content-Disposition header. */
export function invoiceFileName(invoice: Invoice): string {
  const customer = billTo(invoice).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${invoice.invoiceNo}${customer ? `-${customer}` : ""}.pdf`.slice(0, 120);
}
