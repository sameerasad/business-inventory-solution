"use server";

import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import { currentActor, writeAudit } from "@/lib/audit";
import { parseDateOnly } from "@/lib/dates";
import { getReceivables } from "@/lib/bookings";
import { failure, success, type ActionState } from "@/lib/validations";

/**
 * Settling every outstanding invoice at once.
 *
 * This is the one action in the app that writes money across the whole
 * business in a single press, so the shape of it is mostly safety:
 *
 *   counted first   the caller has to send back the number of invoices it was
 *                   shown. That is not a formality typed for its own sake - it
 *                   is how the operation notices that somebody recorded a
 *                   payment, or raised a booking, between the preview and the
 *                   press. A changed count means a changed world, and the run
 *                   is refused rather than applied to a set nobody looked at.
 *   exact balances  each payment is that invoice's remaining balance to the
 *                   cent, read inside the same transaction. Never a share of a
 *                   lump sum, never rounded up.
 *   one batch id    every row written carries it, so the whole run can be
 *                   lifted back off in one go. Undoing two hundred payments by
 *                   hand is not an undo.
 *   all or nothing  one transaction. A half-cleared ledger is worse than an
 *                   uncleared one, because nobody can tell which half.
 *
 * Nothing here touches stock or revenue: the sale happened when the goods went
 * out. This is only the cash arriving, recorded against the invoices it pays.
 */

function revalidateMoney() {
  revalidatePath("/bookings");
  revalidatePath("/receivables");
  revalidatePath("/dashboard");
}

/** Money compares to 2 decimals; finer differences are rounding artefacts. */
const CENT = 0.005;

/** The prefix that marks a payment as part of a bulk run, and names the run. */
const BULK = "bulk";

export type ClearancePreview = {
  invoices: number;
  total: number;
  shops: number;
  oldestDays: number;
};

/**
 * What a clearance would do right now.
 *
 * Deliberately ignores whatever filters the page is showing. The button clears
 * everything outstanding, so the number beside it has to be everything
 * outstanding - a preview that agreed with the filters would under-report the
 * blast radius of the thing it is introducing.
 */
export async function previewClearAllAction(): Promise<ClearancePreview> {
  const { rows } = await getReceivables();
  const owing = rows.filter((r) => r.balance > CENT);
  return {
    invoices: owing.length,
    total: owing.reduce((sum, r) => sum + r.balance, 0),
    shops: new Set(owing.map((r) => r.shopName ?? r.customerName ?? `#${r.id}`)).size,
    oldestDays: owing.reduce((max, r) => Math.max(max, r.daysOutstanding), 0),
  };
}

export async function clearAllReceivablesAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const paidOn = String(formData.get("paidOn") ?? "").trim();
  const method = String(formData.get("method") ?? "").trim() || null;
  const confirmRaw = String(formData.get("confirmCount") ?? "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) {
    return failure("Please fix the highlighted fields.", { paidOn: "Pick a date." });
  }
  const confirmCount = Number.parseInt(confirmRaw, 10);
  if (!Number.isInteger(confirmCount)) {
    return failure("Please fix the highlighted fields.", {
      confirmCount: "Type the number of invoices shown above.",
    });
  }

  const { rows } = await getReceivables();
  const owing = rows.filter((r) => r.balance > CENT);

  if (owing.length === 0) {
    return success("Nothing is outstanding - no payments were recorded.");
  }

  // The count is the agreement about what is being cleared. If it no longer
  // matches, the person is looking at a different ledger than the one in front
  // of them, and the safe move is to make them look again.
  if (confirmCount !== owing.length) {
    return failure(
      `This would clear ${owing.length} invoices, not ${confirmCount}. ` +
        `Close this and open it again to see the current list.`,
      { confirmCount: `Type ${owing.length} to confirm.` },
    );
  }

  const batchId = randomUUID();
  const date = parseDateOnly(paidOn);
  const total = owing.reduce((sum, r) => sum + r.balance, 0);
  const actor = currentActor();

  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.payment.createMany({
          data: owing.map((r) => ({
            bookingId: r.id,
            amount: new Prisma.Decimal(r.balance.toFixed(2)),
            paidOn: date,
            method,
            notes: `Bulk clearance ${batchId}`,
            // Carries the batch, and makes a double submission a no-op rather
            // than a second set of payments.
            idempotencyKey: `${BULK}:${batchId}:${r.id}`,
            createdBy: actor,
          })),
        });

        // One entry for the run rather than one per payment: what matters
        // afterwards is that this happened, when, and to which invoices.
        await writeAudit(tx, {
          entityType: "payment",
          entityId: 0,
          action: "payment.bulk_cleared",
          actor,
          payload: {
            batchId,
            paidOn,
            method,
            invoices: owing.length,
            total,
            // Capped: an audit row is a record, not a second copy of the table.
            invoiceNos: owing.slice(0, 200).map((r) => r.invoiceNo),
            truncated: owing.length > 200,
          },
        });
      },
      { timeout: 30_000 },
    );
  } catch (error) {
    console.error("clearAllReceivablesAction failed", error);
    return failure("Could not clear the invoices. Nothing was recorded.");
  }

  revalidateMoney();
  return success(
    `Cleared ${owing.length} ${owing.length === 1 ? "invoice" : "invoices"} ` +
      `totalling ${total.toFixed(2)}. This can be undone from Receivables.`,
  );
}

export type LastClearance = {
  batchId: string;
  invoices: number;
  total: number;
  paidOn: Date;
  at: Date;
};

/** The most recent bulk run that has not been undone, so it can be offered back. */
export async function getLastClearance(): Promise<LastClearance | null> {
  const newest = await prisma.payment.findFirst({
    where: { isDeleted: false, idempotencyKey: { startsWith: `${BULK}:` } },
    orderBy: { createdAt: "desc" },
    select: { idempotencyKey: true },
  });
  if (!newest?.idempotencyKey) return null;

  const batchId = newest.idempotencyKey.split(":")[1];
  if (!batchId) return null;

  const rows = await prisma.payment.findMany({
    where: { isDeleted: false, idempotencyKey: { startsWith: `${BULK}:${batchId}:` } },
    select: { amount: true, paidOn: true, createdAt: true },
  });
  if (rows.length === 0) return null;

  return {
    batchId,
    invoices: rows.length,
    total: rows.reduce((sum, r) => sum + Number(r.amount), 0),
    paidOn: rows[0]!.paidOn,
    at: rows.reduce((latest, r) => (r.createdAt > latest ? r.createdAt : latest), rows[0]!.createdAt),
  };
}

/**
 * Lift a whole bulk run back off.
 *
 * Soft deletes, like every other payment reversal here: the rows stay so the
 * history shows the money was recorded and then taken back. Payments recorded
 * by hand after the run are untouched - only rows carrying this batch id go.
 */
export async function undoClearanceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const batchId = String(formData.get("batchId") ?? "").trim();
  if (!batchId) return failure("Nothing to undo.");

  const rows = await prisma.payment.findMany({
    where: { isDeleted: false, idempotencyKey: { startsWith: `${BULK}:${batchId}:` } },
    select: { id: true, amount: true },
  });
  if (rows.length === 0) {
    return failure("That clearance has already been undone.");
  }

  const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
  const actor = currentActor();

  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.payment.updateMany({
          where: { id: { in: rows.map((r) => r.id) } },
          data: { isDeleted: true },
        });
        await writeAudit(tx, {
          entityType: "payment",
          entityId: 0,
          action: "payment.bulk_undone",
          actor,
          payload: { batchId, invoices: rows.length, total },
        });
      },
      { timeout: 30_000 },
    );
  } catch (error) {
    console.error("undoClearanceAction failed", error);
    return failure("Could not undo the clearance. Nothing was changed.");
  }

  revalidateMoney();
  return success(
    `Undone. ${rows.length} ${rows.length === 1 ? "payment" : "payments"} ` +
      `totalling ${total.toFixed(2)} were reversed.`,
  );
}
