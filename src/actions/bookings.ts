"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { randomBytes } from "node:crypto";

import { prisma } from "@/lib/db";
import { currentActor, writeAudit } from "@/lib/audit";
import { parseDateOnly } from "@/lib/dates";
import { getInvoice } from "@/lib/bookings";
import { business } from "@/lib/business";
import {
  createBookingSchema,
  failure,
  softDeleteSchema,
  success,
  zodFieldErrors,
  type ActionState,
  type BookingLineInput,
  updateBookingSchema,
} from "@/lib/validations";

/**
 * Unguessable id for a shareable invoice link. 16 random bytes in base64url
 * is 22 characters - short enough for a WhatsApp message, far too large a
 * space to enumerate. The numeric booking id stays for in-app use.
 */
function newShareToken(): string {
  return randomBytes(16).toString("base64url");
}

function revalidateBookings() {
  revalidatePath("/bookings");
  revalidatePath("/bookings/new");
  revalidatePath("/sales");
  revalidatePath("/batches");
  revalidatePath("/products");
  revalidatePath("/dashboard");
}

class ShortStockError extends Error {
  constructor(
    public sku: string,
    public wanted: number,
    public available: number,
  ) {
    super(`Not enough stock for ${sku}`);
    this.name = "ShortStockError";
  }
}

class RaceLostError extends Error {
  constructor(public sku: string) {
    super(`Lost a race allocating ${sku}`);
    this.name = "RaceLostError";
  }
}

/**
 * Hands out the next invoice number for a year.
 *
 * A single INSERT ... ON CONFLICT DO UPDATE ... RETURNING is atomic, so two
 * bookers submitting at the same instant get different numbers without any
 * table-level locking.
 */
async function nextInvoiceNo(tx: Prisma.TransactionClient, year: number): Promise<string> {
  const rows = await tx.$queryRaw<{ last_no: number }[]>(Prisma.sql`
    INSERT INTO invoice_counters (year, last_no)
    VALUES (${year}, 1)
    ON CONFLICT (year) DO UPDATE SET last_no = invoice_counters.last_no + 1
    RETURNING last_no
  `);
  const n = rows[0]?.last_no ?? 1;
  return `INV-${year}-${String(n).padStart(5, "0")}`;
}

/**
 * Records a booking: the order the booker takes, plus the sales it implies.
 *
 * Stock allocation is FIFO. A line for 500 units where the oldest batch has 300
 * left becomes two Sale rows - 300 from that batch and 200 from the next - each
 * carrying its own batch, and therefore its own unit cost. That is what keeps
 * profit exact when a line spans batches bought at different prices.
 *
 * The whole order is one transaction: if the last line is short of stock,
 * nothing at all is written. A partially-fulfilled order with an invoice that
 * does not match is far worse than a rejected one.
 */
export async function createBookingAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = createBookingSchema.safeParse({
    bookerId: formData.get("bookerId") ?? undefined,
    customerName: formData.get("customerName") ?? undefined,
    customerPhone: formData.get("customerPhone") ?? undefined,
    areaId: formData.get("areaId") ?? "",
    shopId: formData.get("shopId") ?? undefined,
    bookingDate: formData.get("bookingDate") ?? "",
    notes: formData.get("notes") ?? undefined,
    lines: formData.get("lines") ?? "",
    idempotencyKey: formData.get("idempotencyKey") ?? undefined,
  });

  if (!parsed.success) {
    return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  }
  const input = parsed.data;

  // A replayed submit returns the original booking instead of double-selling.
  if (input.idempotencyKey) {
    const existing = await prisma.booking.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, invoiceNo: true },
    });
    if (existing) {
      return success(
        `Booking ${existing.invoiceNo} was already recorded (duplicate submission ignored).`,
      );
    }
  }

  // Merge duplicate lines for the same product at the same price, so the invoice
  // shows one tidy row instead of two identical ones.
  const merged = new Map<string, BookingLineInput>();
  for (const line of input.lines) {
    const key = `${line.productId}:${line.unitPrice.toFixed(2)}`;
    const found = merged.get(key);
    if (found) found.quantity += line.quantity;
    else merged.set(key, { ...line });
  }
  const lines = [...merged.values()];

  const [area, shop, products] = await Promise.all([
    prisma.area.findUnique({ where: { id: input.areaId }, select: { id: true, isDeleted: true } }),
    input.shopId
      ? prisma.shop.findUnique({
          where: { id: input.shopId },
          select: { id: true, areaId: true, isDeleted: true },
        })
      : Promise.resolve(null),
    prisma.product.findMany({
      where: { id: { in: lines.map((l) => l.productId) } },
      select: { id: true, sku: true, unit: true },
    }),
  ]);

  if (!area || area.isDeleted) {
    return failure("That area is no longer available.", { areaId: "Pick another area" });
  }
  if (input.shopId) {
    if (!shop || shop.isDeleted) {
      return failure("That shop is no longer available.", { shopId: "Pick another shop" });
    }
    if (shop.areaId !== input.areaId) {
      return failure("That shop is not in the selected area.", {
        shopId: "Pick a shop inside the selected area",
      });
    }
  }

  const bySku = new Map(products.map((p) => [p.id, p]));
  const unknown = lines.find((l) => !bySku.has(l.productId));
  if (unknown) {
    return failure("One of the products no longer exists. Remove that line and try again.", {
      lines: "Unknown product",
    });
  }

  const saleDate = parseDateOnly(input.bookingDate);
  const actor = currentActor();

  try {
    const result = await prisma.$transaction(async (tx) => {
      const invoiceNo = await nextInvoiceNo(tx, saleDate.getUTCFullYear());

      const booking = await tx.booking.create({
        data: {
          invoiceNo,
          shareToken: newShareToken(),
          bookerId: input.bookerId,
          customerName: input.customerName,
          customerPhone: input.customerPhone,
          areaId: input.areaId,
          shopId: input.shopId,
          bookingDate: saleDate,
          notes: input.notes,
          idempotencyKey: input.idempotencyKey,
          createdBy: actor,
        },
        select: { id: true, invoiceNo: true },
      });

      let orderTotal = 0;
      let saleRows = 0;

      for (const line of lines) {
        const product = bySku.get(line.productId)!;

        const batches = await tx.batch.findMany({
          where: { productId: line.productId, isDeleted: false, remainingQty: { gt: 0 } },
          orderBy: [{ receivedDate: "asc" }, { id: "asc" }],
          select: { id: true, remainingQty: true },
        });

        const available = batches.reduce((sum, b) => sum + b.remainingQty, 0);
        if (available < line.quantity) {
          throw new ShortStockError(product.sku, line.quantity, available);
        }

        let outstanding = line.quantity;
        for (const batch of batches) {
          if (outstanding === 0) break;
          const take = Math.min(batch.remainingQty, outstanding);

          // Guarded decrement: matches zero rows if someone else drained the
          // batch between the read above and here, which aborts the order.
          const deducted = await tx.batch.updateMany({
            where: { id: batch.id, isDeleted: false, remainingQty: { gte: take } },
            data: { remainingQty: { decrement: take } },
          });
          if (deducted.count !== 1) throw new RaceLostError(product.sku);

          await tx.sale.create({
            data: {
              productId: line.productId,
              batchId: batch.id,
              areaId: input.areaId,
              shopId: input.shopId,
              bookingId: booking.id,
              quantity: take,
              salePrice: new Prisma.Decimal(line.unitPrice.toFixed(2)),
              saleDate,
              createdBy: actor,
            },
          });

          outstanding -= take;
          saleRows += 1;
        }

        orderTotal += line.unitPrice * line.quantity;
      }

      await writeAudit(tx, {
        entityType: "booking",
        entityId: booking.id,
        action: "booking.created",
        actor,
        payload: {
          invoiceNo: booking.invoiceNo,
          customer: input.customerName,
          bookerId: input.bookerId,
          lines: lines.map((l) => ({
            sku: bySku.get(l.productId)!.sku,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
          })),
          saleRows,
          orderTotal,
        },
      });

      return { id: booking.id, invoiceNo: booking.invoiceNo, orderTotal, saleRows };
    });

    revalidateBookings();
    return success(
      `Booking ${result.invoiceNo} recorded${input.customerName ? ` for ${input.customerName}` : ""} - ${lines.length} line(s), ${result.saleRows} stock movement(s).`,
    );
  } catch (error) {
    if (error instanceof ShortStockError) {
      return failure(
        `Not enough stock for ${error.sku}: ${error.wanted} requested but only ${error.available} available. Nothing was saved - reduce that line or receive a batch first.`,
        { lines: `${error.sku}: only ${error.available} in stock` },
      );
    }
    if (error instanceof RaceLostError) {
      return failure(
        `Stock for ${error.sku} changed while this order was being saved. Nothing was saved - please reload and try again.`,
        { lines: "Stock changed, reload and retry" },
      );
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return success("This booking was already recorded (duplicate submission ignored).");
    }
    console.error("createBookingAction failed", error);
    return failure("Could not save the booking. Please try again.");
  }
}

/**
 * The token for a booking's shareable invoice link, minted on demand for any
 * booking recorded before share links existed.
 */
export async function getInvoiceShareToken(bookingId: number): Promise<string | null> {
  if (!Number.isInteger(bookingId) || bookingId <= 0) return null;
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, shareToken: true },
  });
  if (!booking) return null;
  if (booking.shareToken) return booking.shareToken;

  const token = newShareToken();
  await prisma.booking.update({ where: { id: booking.id }, data: { shareToken: token } });
  return token;
}

/**
 * Everything the WhatsApp dialog needs, in one round trip: the share token
 * (minted on demand for bookings older than share links), the business name
 * from the server environment, and the invoice lines.
 *
 * Deliberately mirrors the invoice itself - quantities, prices and totals, no
 * unit cost and no profit. This text goes to a customer.
 */
export async function getInvoiceShareData(bookingId: number): Promise<
  | {
      token: string;
      invoiceNo: string;
      businessName: string;
      bookingDate: string;
      customerName: string | null;
      shopName: string | null;
      lines: { description: string; quantity: number; unitPrice: number; lineTotal: number }[];
      total: number;
      totalUnits: number;
    }
  | null
> {
  const token = await getInvoiceShareToken(bookingId);
  if (!token) return null;

  const invoice = await getInvoice(bookingId);
  if (!invoice) return null;

  return {
    token,
    invoiceNo: invoice.invoiceNo,
    businessName: business().name,
    bookingDate: invoice.bookingDate.toISOString().slice(0, 10),
    customerName: invoice.customerName,
    shopName: invoice.shopName,
    lines: invoice.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      lineTotal: l.lineTotal,
    })),
    total: invoice.subtotal,
    totalUnits: invoice.totalUnits,
  };
}

/**
 * Soft delete a booking: flags it, flags all its sales, and returns every
 * allocated unit to the batch it came from. One transaction, so stock stays
 * reconciled. The row is kept so the invoice number is never reused.
 */
export async function softDeleteBookingAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = softDeleteSchema.safeParse({
    id: formData.get("id") ?? "",
    reason: formData.get("reason") ?? undefined,
  });
  if (!parsed.success) return failure("Invalid request.", zodFieldErrors(parsed.error));
  const { id, reason } = parsed.data;

  try {
    const message = await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { id },
        select: {
          id: true,
          invoiceNo: true,
          isDeleted: true,
          sales: { where: { isDeleted: false }, select: { id: true, batchId: true, quantity: true } },
          // Cancelling must void the money as well as the goods. Leaving a
          // payment live against a cancelled order makes "collected" claim cash
          // for something that was never sold.
          payments: { where: { isDeleted: false }, select: { id: true, amount: true } },
        },
      });
      if (!booking) return null;
      if (booking.isDeleted) return `Booking ${booking.invoiceNo} is already cancelled.`;

      for (const sale of booking.sales) {
        await tx.sale.update({ where: { id: sale.id }, data: { isDeleted: true } });
        await tx.batch.update({
          where: { id: sale.batchId },
          data: { remainingQty: { increment: sale.quantity } },
        });
      }
      for (const payment of booking.payments) {
        await tx.payment.update({ where: { id: payment.id }, data: { isDeleted: true } });
      }
      await tx.booking.update({ where: { id }, data: { isDeleted: true } });

      const returned = booking.sales.reduce((sum, s) => sum + s.quantity, 0);
      const reversed = booking.payments.reduce((sum, p) => sum + Number(p.amount), 0);
      await writeAudit(tx, {
        entityType: "booking",
        entityId: id,
        action: "booking.cancelled",
        payload: {
          reason,
          invoiceNo: booking.invoiceNo,
          unitsReturned: returned,
          paymentsReversed: booking.payments.length,
          amountReversed: reversed,
        },
      });

      return (
        `Booking ${booking.invoiceNo} cancelled. ${returned} unit(s) returned to stock` +
        (booking.payments.length > 0
          ? `, and ${booking.payments.length} payment(s) totalling ${reversed.toFixed(2)} reversed.`
          : ".")
      );
    });

    if (message === null) return failure("Booking not found.");
    revalidateBookings();
    return success(message);
  } catch (error) {
    console.error("softDeleteBookingAction failed", error);
    return failure("Could not cancel the booking. Please try again.");
  }
}

/**
 * Edit a booking's own details: customer, contact, date, area, shop, booker and
 * notes.
 *
 * The order LINES are not edited here. A line is a sale row with its own batch
 * and its own stock movement, so it is edited on the Sales page - one rule for
 * inventory instead of two.
 *
 * Moving the booking date moves the sale dates with it, because a delivery
 * cannot be dated differently from the order it belongs to. Payments keep their
 * own dates: when the money arrived is a separate fact from when the goods went.
 */
export async function updateBookingAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = updateBookingSchema.safeParse({
    id: formData.get("id") ?? "",
    bookerId: formData.get("bookerId") ?? undefined,
    customerName: formData.get("customerName") ?? undefined,
    customerPhone: formData.get("customerPhone") ?? undefined,
    areaId: formData.get("areaId") ?? "",
    shopId: formData.get("shopId") ?? undefined,
    bookingDate: formData.get("bookingDate") ?? "",
    notes: formData.get("notes") ?? undefined,
  });
  if (!parsed.success) {
    return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  }
  const input = parsed.data;

  const booking = await prisma.booking.findUnique({
    where: { id: input.id },
    select: {
      id: true,
      invoiceNo: true,
      isDeleted: true,
      areaId: true,
      shopId: true,
      bookerId: true,
      bookingDate: true,
      customerName: true,
    },
  });
  if (!booking) return failure("Booking not found.");
  if (booking.isDeleted) return failure("That booking is cancelled and cannot be edited.");

  const [area, shop, booker] = await Promise.all([
    prisma.area.findUnique({ where: { id: input.areaId }, select: { isDeleted: true } }),
    input.shopId
      ? prisma.shop.findUnique({
          where: { id: input.shopId },
          select: { areaId: true, isDeleted: true },
        })
      : Promise.resolve(null),
    input.bookerId
      ? prisma.booker.findUnique({
          where: { id: input.bookerId },
          select: { isDeleted: true },
        })
      : Promise.resolve(null),
  ]);

  if (!area || area.isDeleted) {
    return failure("That area is no longer available.", { areaId: "Pick another area" });
  }
  if (input.shopId) {
    if (!shop || shop.isDeleted) {
      return failure("That shop is no longer available.", { shopId: "Pick another shop" });
    }
    if (shop.areaId !== input.areaId) {
      return failure("That shop is not in the selected area.", {
        shopId: "Pick a shop inside the selected area",
      });
    }
  }
  if (input.bookerId && (!booker || booker.isDeleted)) {
    return failure("That booker is no longer available.", { bookerId: "Pick another booker" });
  }

  const newDate = parseDateOnly(input.bookingDate);

  await prisma.$transaction(async (tx) => {
    await tx.booking.update({
      where: { id: input.id },
      data: {
        bookerId: input.bookerId,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        areaId: input.areaId,
        shopId: input.shopId,
        bookingDate: newDate,
        notes: input.notes,
      },
    });

    // The sale rows carry their own area, shop and date for query speed, so
    // they have to follow the booking or the two would disagree.
    await tx.sale.updateMany({
      where: { bookingId: input.id, isDeleted: false },
      data: { areaId: input.areaId, shopId: input.shopId, saleDate: newDate },
    });

    await writeAudit(tx, {
      entityType: "booking",
      entityId: input.id,
      action: "booking.updated",
      payload: {
        invoiceNo: booking.invoiceNo,
        before: {
          areaId: booking.areaId,
          shopId: booking.shopId,
          bookerId: booking.bookerId,
          bookingDate: booking.bookingDate.toISOString().slice(0, 10),
          customerName: booking.customerName,
        },
        after: {
          areaId: input.areaId,
          shopId: input.shopId,
          bookerId: input.bookerId,
          bookingDate: input.bookingDate,
          customerName: input.customerName,
        },
      },
    });
  });

  revalidateBookings();
  revalidatePath("/sales");
  return success(`${booking.invoiceNo} updated.`);
}
