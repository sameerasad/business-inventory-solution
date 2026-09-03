"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import { currentActor, writeAudit } from "@/lib/audit";
import { parseDateOnly } from "@/lib/dates";
import { getAvailableBatchesForProduct, type AvailableBatch } from "@/lib/queries";
import {
  createSaleSchema,
  failure,
  softDeleteSchema,
  success,
  updateSaleSchema,
  zodFieldErrors,
  type ActionState,
} from "@/lib/validations";

function revalidateSales() {
  revalidatePath("/sales");
  revalidatePath("/sales/new");
  revalidatePath("/batches");
  revalidatePath("/products");
  revalidatePath("/dashboard");
}

/** Called from the New Sale form when the selected product changes. */
export async function fetchAvailableBatches(productId: number): Promise<AvailableBatch[]> {
  if (!Number.isInteger(productId) || productId <= 0) return [];
  return getAvailableBatchesForProduct(productId);
}

/**
 * Inventory OUT. Records a sale and deducts it from the chosen batch.
 *
 * The deduction is a single conditional UPDATE:
 *   UPDATE batches SET remaining_qty = remaining_qty - q
 *    WHERE id = ? AND is_deleted = false AND remaining_qty >= q
 * If it matches zero rows another sale drained the batch first and we abort. That
 * makes overselling impossible without locking the table, and the CHECK
 * constraint on remaining_qty is the final backstop underneath it.
 *
 * Profit is not written anywhere - it is derived at read time from
 * (sale_price - batch.unit_cost) * quantity.
 */
export async function createSaleAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = createSaleSchema.safeParse({
    productId: formData.get("productId") ?? "",
    batchId: formData.get("batchId") ?? "",
    areaId: formData.get("areaId") ?? "",
    shopId: formData.get("shopId") ?? undefined,
    quantity: formData.get("quantity") ?? "",
    salePrice: formData.get("salePrice") ?? "",
    saleDate: formData.get("saleDate") ?? "",
    notes: formData.get("notes") ?? undefined,
    idempotencyKey: formData.get("idempotencyKey") ?? undefined,
  });

  if (!parsed.success) {
    return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  }
  const input = parsed.data;

  if (input.idempotencyKey) {
    const existing = await prisma.sale.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true },
    });
    if (existing) {
      return success(`Sale #${existing.id} was already recorded (duplicate submission ignored).`);
    }
  }

  // --- Referential checks, so the user gets a clear message instead of an FK error.
  const [batch, area, shop] = await Promise.all([
    prisma.batch.findUnique({
      where: { id: input.batchId },
      select: { id: true, productId: true, remainingQty: true, isDeleted: true, unitCost: true },
    }),
    prisma.area.findUnique({ where: { id: input.areaId }, select: { id: true, isDeleted: true } }),
    input.shopId
      ? prisma.shop.findUnique({
          where: { id: input.shopId },
          select: { id: true, areaId: true, isDeleted: true },
        })
      : Promise.resolve(null),
  ]);

  if (!batch || batch.isDeleted) {
    return failure("That batch is no longer available.", { batchId: "Pick another batch" });
  }
  if (batch.productId !== input.productId) {
    return failure("That batch belongs to a different product.", {
      batchId: "Pick a batch for the selected product",
    });
  }
  if (batch.remainingQty < input.quantity) {
    return failure(
      `Batch #${batch.id} only has ${batch.remainingQty} unit(s) left. Reduce the quantity or split the sale across batches.`,
      { quantity: `Maximum available is ${batch.remainingQty}` },
    );
  }
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

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Atomic guarded deduction - no read-then-write gap to lose a race in.
      const deducted = await tx.batch.updateMany({
        where: {
          id: batch.id,
          isDeleted: false,
          remainingQty: { gte: input.quantity },
        },
        data: { remainingQty: { decrement: input.quantity } },
      });

      if (deducted.count !== 1) {
        // Nothing has been written yet; abort with a typed signal.
        throw new InsufficientStockError(batch.id);
      }

      const sale = await tx.sale.create({
        data: {
          productId: input.productId,
          batchId: batch.id,
          areaId: input.areaId,
          shopId: input.shopId,
          quantity: input.quantity,
          salePrice: new Prisma.Decimal(input.salePrice.toFixed(2)),
          saleDate: parseDateOnly(input.saleDate),
          notes: input.notes,
          idempotencyKey: input.idempotencyKey,
          createdBy: currentActor(),
        },
        select: { id: true },
      });

      const after = await tx.batch.findUniqueOrThrow({
        where: { id: batch.id },
        select: { remainingQty: true },
      });

      await writeAudit(tx, {
        entityType: "sale",
        entityId: sale.id,
        action: "sale.created",
        payload: {
          batchId: batch.id,
          quantity: input.quantity,
          salePrice: input.salePrice,
          unitCost: Number(batch.unitCost),
          areaId: input.areaId,
          shopId: input.shopId,
          saleDate: input.saleDate,
          batchRemainingAfter: after.remainingQty,
        },
      });

      return { saleId: sale.id, remainingAfter: after.remainingQty };
    });

    revalidateSales();

    const unitCost = Number(batch.unitCost);
    const profit = (input.salePrice - unitCost) * input.quantity;
    return success(
      `Sale #${result.saleId} recorded. Profit ${profit.toFixed(2)}. Batch #${batch.id} has ${result.remainingAfter} left.`,
    );
  } catch (error) {
    if (error instanceof InsufficientStockError) {
      return failure(
        `Batch #${error.batchId} no longer has enough stock - someone else may have just sold from it. Reload and try again.`,
        { batchId: "Reload the batch list" },
      );
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return success("This sale was already recorded (duplicate submission ignored).");
    }
    console.error("createSaleAction failed", error);
    return failure("Could not save the sale. Please try again.");
  }
}

class PaidBookingError extends Error {
  constructor(
    public invoiceNo: string,
    public paymentCount: number,
  ) {
    super(`${invoiceNo} has payments recorded`);
    this.name = "PaidBookingError";
  }
}

class InsufficientStockError extends Error {
  constructor(public batchId: number) {
    super(`Batch ${batchId} has insufficient stock`);
    this.name = "InsufficientStockError";
  }
}

/**
 * Soft delete a sale and return its quantity to the batch, so stock stays
 * reconciled. Both halves happen in one transaction.
 */
export async function softDeleteSaleAction(
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
      const sale = await tx.sale.findUnique({
        where: { id },
        select: {
          id: true,
          isDeleted: true,
          batchId: true,
          quantity: true,
          bookingId: true,
          booking: {
            select: {
              invoiceNo: true,
              _count: { select: { payments: { where: { isDeleted: false } } } },
            },
          },
        },
      });
      if (!sale) return null;
      if (sale.isDeleted) return `Sale #${id} is already removed.`;

      // Removing a sale shrinks its booking's invoice value. If money has been
      // received against that booking, the result is an invoice worth less than
      // has been paid for it - which is what makes "collected" exceed
      // "invoiced". Reverse the payment first, deliberately.
      if (sale.booking && sale.booking._count.payments > 0) {
        throw new PaidBookingError(sale.booking.invoiceNo, sale.booking._count.payments);
      }

      await tx.sale.update({ where: { id }, data: { isDeleted: true } });
      await tx.batch.update({
        where: { id: sale.batchId },
        data: { remainingQty: { increment: sale.quantity } },
      });
      await writeAudit(tx, {
        entityType: "sale",
        entityId: id,
        action: "sale.soft_deleted",
        payload: { reason, restoredToBatch: sale.batchId, quantity: sale.quantity },
      });

      return `Sale #${id} removed and ${sale.quantity} unit(s) returned to batch #${sale.batchId}.`;
    });

    if (message === null) return failure("Sale not found.");
    revalidateSales();
    return success(message);
  } catch (error) {
    if (error instanceof PaidBookingError) {
      return failure(
        `This sale belongs to ${error.invoiceNo}, which has ${error.paymentCount} payment(s) recorded against it. ` +
          "Reverse the payment on the Bookings page first, or cancel the whole booking - " +
          "otherwise the invoice would be worth less than has been paid for it.",
      );
    }
    console.error("softDeleteSaleAction failed", error);
    return failure("Could not remove the sale. Please try again.");
  }
}

/**
 * Edit a recorded sale: quantity, price, date, area, shop and batch.
 *
 * Stock is reconciled by returning the old quantity and taking the new one, so
 * the batch totals stay exact whether the quantity went up, went down, or moved
 * to a different batch entirely. The take is the same atomic guarded UPDATE the
 * create path uses, so two people editing at once cannot oversell between them.
 *
 * The product is fixed. A different product is a different sale, and re-pointing
 * one would move stock between catalog entries.
 *
 * A line belonging to an invoice with payments against it is refused when the
 * change would shrink the invoice below what has been paid - the same rule that
 * stops a sale being deleted out from under its payments.
 */
export async function updateSaleAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = updateSaleSchema.safeParse({
    id: formData.get("id") ?? "",
    batchId: formData.get("batchId") ?? "",
    areaId: formData.get("areaId") ?? "",
    shopId: formData.get("shopId") ?? undefined,
    quantity: formData.get("quantity") ?? "",
    salePrice: formData.get("salePrice") ?? "",
    saleDate: formData.get("saleDate") ?? "",
    notes: formData.get("notes") ?? undefined,
  });
  if (!parsed.success) {
    return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  }
  const input = parsed.data;

  const sale = await prisma.sale.findUnique({
    where: { id: input.id },
    select: {
      id: true,
      isDeleted: true,
      productId: true,
      batchId: true,
      quantity: true,
      salePrice: true,
      areaId: true,
      shopId: true,
      saleDate: true,
      bookingId: true,
      booking: { select: { invoiceNo: true } },
    },
  });
  if (!sale) return failure("Sale not found.");
  if (sale.isDeleted) return failure("That sale has been removed and cannot be edited.");

  const [batch, area, shop] = await Promise.all([
    prisma.batch.findUnique({
      where: { id: input.batchId },
      select: { id: true, productId: true, quantity: true, remainingQty: true, isDeleted: true, unitCost: true },
    }),
    prisma.area.findUnique({ where: { id: input.areaId }, select: { isDeleted: true } }),
    input.shopId
      ? prisma.shop.findUnique({
          where: { id: input.shopId },
          select: { areaId: true, isDeleted: true },
        })
      : Promise.resolve(null),
  ]);

  if (!batch || batch.isDeleted) {
    return failure("That batch is no longer available.", { batchId: "Pick another batch" });
  }
  if (batch.productId !== sale.productId) {
    return failure("That batch belongs to a different product.", {
      batchId: "Pick a batch for this product",
    });
  }
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

  const sameBatch = batch.id === sale.batchId;
  // Available to this edit: what is free in the batch, plus what this very sale
  // is currently holding in it. Without the second half, raising a sale from 10
  // to 11 in a batch with nothing spare would be refused even though 10 of the
  // 11 are already its own.
  const headroom = sameBatch ? batch.remainingQty + sale.quantity : batch.remainingQty;
  if (input.quantity > headroom) {
    return failure(
      `Batch #${batch.id} can only cover ${headroom} unit(s) for this sale.`,
      { quantity: `Maximum available is ${headroom}` },
    );
  }

  // An invoice must never end up worth less than has been paid against it.
  if (sale.bookingId) {
    const [paidAgg, otherLines] = await Promise.all([
      prisma.payment.aggregate({
        where: { bookingId: sale.bookingId, isDeleted: false },
        _sum: { amount: true },
      }),
      prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
        SELECT COALESCE(SUM(s.sale_price * s.quantity), 0)::float8 AS total
        FROM sales s
        JOIN batches b ON b.id = s.batch_id
        WHERE s.booking_id = ${sale.bookingId}
          AND s.is_deleted = false
          AND b.is_deleted = false
          AND s.id <> ${sale.id}
      `),
    ]);
    const paid = Number(paidAgg._sum.amount ?? 0);
    const newTotal = (otherLines[0]?.total ?? 0) + input.quantity * input.salePrice;
    if (paid > newTotal + 0.005) {
      return failure(
        `${sale.booking?.invoiceNo} has ${paid.toFixed(2)} paid against it. This change would drop the ` +
          `invoice to ${newTotal.toFixed(2)}, less than has been received. Reverse or reduce the payment first.`,
        { quantity: "Would undercut the payments" },
      );
    }
  }

  try {
    const remainingAfter = await prisma.$transaction(async (tx) => {
      // 1. Put the old quantity back. Capped by the CHECK constraint on
      //    remaining_qty <= quantity, which is why the old batch is read back.
      await tx.batch.update({
        where: { id: sale.batchId },
        data: { remainingQty: { increment: sale.quantity } },
      });

      // 2. Take the new quantity, guarded, so a concurrent sale cannot oversell.
      const taken = await tx.batch.updateMany({
        where: { id: batch.id, isDeleted: false, remainingQty: { gte: input.quantity } },
        data: { remainingQty: { decrement: input.quantity } },
      });
      if (taken.count !== 1) throw new InsufficientStockError(batch.id);

      await tx.sale.update({
        where: { id: input.id },
        data: {
          batchId: batch.id,
          areaId: input.areaId,
          shopId: input.shopId,
          quantity: input.quantity,
          salePrice: new Prisma.Decimal(input.salePrice.toFixed(2)),
          saleDate: parseDateOnly(input.saleDate),
          notes: input.notes,
        },
      });

      const after = await tx.batch.findUniqueOrThrow({
        where: { id: batch.id },
        select: { remainingQty: true },
      });

      await writeAudit(tx, {
        entityType: "sale",
        entityId: input.id,
        action: "sale.updated",
        payload: {
          before: {
            batchId: sale.batchId,
            quantity: sale.quantity,
            salePrice: Number(sale.salePrice),
            areaId: sale.areaId,
            shopId: sale.shopId,
            saleDate: sale.saleDate.toISOString().slice(0, 10),
          },
          after: {
            batchId: batch.id,
            quantity: input.quantity,
            salePrice: input.salePrice,
            areaId: input.areaId,
            shopId: input.shopId,
            saleDate: input.saleDate,
          },
          unitCost: Number(batch.unitCost),
          batchRemainingAfter: after.remainingQty,
        },
      });

      return after.remainingQty;
    });

    revalidateSales();
    revalidatePath("/bookings");
    revalidatePath("/receivables");

    const profit = (input.salePrice - Number(batch.unitCost)) * input.quantity;
    return success(
      `Sale #${input.id} updated. Profit ${profit.toFixed(2)}. Batch #${batch.id} has ${remainingAfter} left.`,
    );
  } catch (error) {
    if (error instanceof InsufficientStockError) {
      return failure(
        `Batch #${error.batchId} no longer has enough stock - someone else may have just sold from it. Reload and try again.`,
        { batchId: "Reload the batch list" },
      );
    }
    console.error("updateSaleAction failed", error);
    return failure("Could not save the sale. Please try again.");
  }
}
