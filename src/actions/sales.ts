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
        select: { id: true, isDeleted: true, batchId: true, quantity: true },
      });
      if (!sale) return null;
      if (sale.isDeleted) return `Sale #${id} is already removed.`;

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
    console.error("softDeleteSaleAction failed", error);
    return failure("Could not remove the sale. Please try again.");
  }
}
