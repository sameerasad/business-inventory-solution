"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import { currentActor, writeAudit } from "@/lib/audit";
import { parseDateOnly } from "@/lib/dates";
import { getBookingBalance, getPayments, paymentStatus, type PaymentRow } from "@/lib/bookings";
import {
  createPaymentSchema,
  failure,
  softDeleteSchema,
  success,
  updatePaymentSchema,
  zodFieldErrors,
  type ActionState,
} from "@/lib/validations";

function revalidateMoney() {
  revalidatePath("/bookings");
  revalidatePath("/receivables");
  revalidatePath("/dashboard");
}

/** Money compares to 2 decimals; finer differences are rounding artefacts. */
const CENT = 0.005;

/**
 * Records a payment received against a booking.
 *
 * Payments never touch stock or revenue. The sale already happened when the
 * goods went out; this is the cash arriving afterwards. Paid / partial / unpaid
 * is derived from these rows, so recording one is purely additive - nothing to
 * keep in sync.
 */
export async function recordPaymentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = createPaymentSchema.safeParse({
    bookingId: formData.get("bookingId") ?? "",
    amount: formData.get("amount") ?? "",
    paidOn: formData.get("paidOn") ?? "",
    method: formData.get("method") ?? undefined,
    notes: formData.get("notes") ?? undefined,
    idempotencyKey: formData.get("idempotencyKey") ?? undefined,
  });

  if (!parsed.success) {
    return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  }
  const input = parsed.data;

  // A replayed submit must not record the money twice.
  if (input.idempotencyKey) {
    const existing = await prisma.payment.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true },
    });
    if (existing) {
      return success("That payment was already recorded (duplicate submission ignored).");
    }
  }

  const booking = await prisma.booking.findUnique({
    where: { id: input.bookingId },
    select: { id: true, invoiceNo: true, isDeleted: true },
  });
  if (!booking) return failure("Booking not found.");
  if (booking.isDeleted) {
    return failure(`${booking.invoiceNo} is cancelled, so no payment can be recorded against it.`);
  }

  const before = await getBookingBalance(input.bookingId);
  if (!before) return failure("Booking not found.");

  // Refuse to take more than is owed. Overpayment is nearly always a typo, and
  // silently accepting it would make the receivables list nonsense.
  if (input.amount > before.balance + CENT) {
    return failure(
      `That is more than is owed. ${booking.invoiceNo} has a balance of ${before.balance.toFixed(2)}.`,
      { amount: `Maximum is ${before.balance.toFixed(2)}` },
    );
  }

  try {
    await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          bookingId: input.bookingId,
          amount: new Prisma.Decimal(input.amount.toFixed(2)),
          paidOn: parseDateOnly(input.paidOn),
          method: input.method,
          notes: input.notes,
          idempotencyKey: input.idempotencyKey,
          createdBy: currentActor(),
        },
        select: { id: true },
      });

      await writeAudit(tx, {
        entityType: "payment",
        entityId: payment.id,
        action: "payment.received",
        payload: {
          bookingId: input.bookingId,
          invoiceNo: booking.invoiceNo,
          amount: input.amount,
          paidOn: input.paidOn,
          method: input.method,
          balanceBefore: before.balance,
          balanceAfter: before.balance - input.amount,
        },
      });
    });

    const after = before.balance - input.amount;
    const status = paymentStatus(before.total, before.paid + input.amount);

    revalidateMoney();
    return success(
      status === "paid"
        ? `Payment recorded. ${booking.invoiceNo} is now fully paid.`
        : `Payment recorded. ${booking.invoiceNo} still has ${after.toFixed(2)} outstanding.`,
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return success("That payment was already recorded (duplicate submission ignored).");
    }
    console.error("recordPaymentAction failed", error);
    return failure("Could not record the payment. Please try again.");
  }
}

/**
 * Soft delete a payment - for a mistyped amount or a bounced cheque. The row is
 * kept so the history shows it happened and was reversed.
 */
export async function deletePaymentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = softDeleteSchema.safeParse({
    id: formData.get("id") ?? "",
    reason: formData.get("reason") ?? undefined,
  });
  if (!parsed.success) return failure("Invalid request.", zodFieldErrors(parsed.error));
  const { id, reason } = parsed.data;

  const payment = await prisma.payment.findUnique({
    where: { id },
    select: { id: true, amount: true, isDeleted: true, booking: { select: { invoiceNo: true } } },
  });
  if (!payment) return failure("Payment not found.");
  if (payment.isDeleted) return success("That payment is already reversed.");

  await prisma.$transaction(async (tx) => {
    await tx.payment.update({ where: { id }, data: { isDeleted: true } });
    await writeAudit(tx, {
      entityType: "payment",
      entityId: id,
      action: "payment.reversed",
      payload: { reason, amount: Number(payment.amount), invoiceNo: payment.booking.invoiceNo },
    });
  });

  revalidateMoney();
  return success(
    `Payment of ${Number(payment.amount).toFixed(2)} reversed on ${payment.booking.invoiceNo}.`,
  );
}

/** Payment history plus the current balance, for the payment dialog. */
export async function getPaymentDetails(bookingId: number): Promise<{
  payments: PaymentRow[];
  total: number;
  paid: number;
  balance: number;
  status: "unpaid" | "partial" | "paid";
} | null> {
  if (!Number.isInteger(bookingId) || bookingId <= 0) return null;
  const balance = await getBookingBalance(bookingId);
  if (!balance) return null;
  return { payments: await getPayments(bookingId), ...balance };
}

/**
 * Correct a payment: its amount, the date it arrived, how it arrived, and any
 * note.
 *
 * The date matters as much as the amount. Revenue is recognised on the CASH
 * basis, dated by the payment, so moving a payment from March to April moves
 * that revenue between months on the dashboard. It is meant to.
 *
 * The invoice it belongs to is deliberately not editable here. Moving money
 * between invoices is two separate acts - unpaying one and paying the other -
 * and hiding that inside an edit would leave both invoices looking wrong.
 */
export async function updatePaymentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = updatePaymentSchema.safeParse({
    id: formData.get("id") ?? "",
    amount: formData.get("amount") ?? "",
    paidOn: formData.get("paidOn") ?? "",
    method: formData.get("method") ?? undefined,
    notes: formData.get("notes") ?? undefined,
  });
  if (!parsed.success) {
    return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  }
  const { id, amount, paidOn, method, notes } = parsed.data;

  const payment = await prisma.payment.findUnique({
    where: { id },
    select: {
      id: true,
      isDeleted: true,
      bookingId: true,
      amount: true,
      paidOn: true,
      booking: { select: { invoiceNo: true } },
    },
  });
  if (!payment) return failure("Payment not found.");
  if (payment.isDeleted) return failure("That payment has been reversed and cannot be edited.");

  // What the invoice is worth, and what its OTHER payments already cover. An
  // amount above the remainder is almost always a typo, so it is refused with
  // the actual figure rather than quietly creating an overpaid invoice.
  const [total, otherPaid] = await Promise.all([
    getBookingInvoiceTotal(payment.bookingId),
    prisma.payment.aggregate({
      where: { bookingId: payment.bookingId, isDeleted: false, id: { not: id } },
      _sum: { amount: true },
    }),
  ]);
  const already = Number(otherPaid._sum.amount ?? 0);
  const room = total - already;
  if (amount > room + 0.005) {
    return failure(
      `${payment.booking.invoiceNo} is worth ${total.toFixed(2)} and ${already.toFixed(2)} is already ` +
        `recorded against it, so this payment cannot exceed ${room.toFixed(2)}.`,
      { amount: `Maximum is ${room.toFixed(2)}` },
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id },
      data: {
        amount: new Prisma.Decimal(amount.toFixed(2)),
        paidOn: parseDateOnly(paidOn),
        method,
        notes,
      },
    });
    await writeAudit(tx, {
      entityType: "payment",
      entityId: id,
      action: "payment.updated",
      payload: {
        bookingId: payment.bookingId,
        before: {
          amount: Number(payment.amount),
          paidOn: payment.paidOn.toISOString().slice(0, 10),
        },
        after: { amount, paidOn },
      },
    });
  });

  revalidateMoney();
  return success(`Payment on ${payment.booking.invoiceNo} updated.`);
}

/** Invoice value of a booking: the sum of its live sale lines. */
async function getBookingInvoiceTotal(bookingId: number): Promise<number> {
  const rows = await prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
    SELECT COALESCE(SUM(s.sale_price * s.quantity), 0)::float8 AS total
    FROM sales s
    JOIN batches b ON b.id = s.batch_id
    WHERE s.booking_id = ${bookingId} AND s.is_deleted = false AND b.is_deleted = false
  `);
  return rows[0]?.total ?? 0;
}
