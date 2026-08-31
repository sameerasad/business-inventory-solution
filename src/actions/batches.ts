"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import { currentActor, writeAudit } from "@/lib/audit";
import { parseDateOnly } from "@/lib/dates";
import {
  createBatchSchema,
  failure,
  softDeleteSchema,
  success,
  zodFieldErrors,
  type ActionState,
} from "@/lib/validations";

function revalidateInventory() {
  revalidatePath("/batches");
  revalidatePath("/batches/new");
  revalidatePath("/products");
  revalidatePath("/dashboard");
  revalidatePath("/sales/new");
}

/**
 * Inventory IN. Creates a batch with remaining_qty == quantity.
 *
 * Idempotency: the form sends a key minted once per render. A double submit
 * reuses it, the unique index rejects the second insert, and we report the
 * original batch instead of receiving the same stock twice.
 */
export async function createBatchAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = createBatchSchema.safeParse({
    productId: formData.get("productId") ?? "",
    quantity: formData.get("quantity") ?? "",
    unitCost: formData.get("unitCost") ?? "",
    receivedDate: formData.get("receivedDate") ?? "",
    notes: formData.get("notes") ?? undefined,
    idempotencyKey: formData.get("idempotencyKey") ?? undefined,
  });

  if (!parsed.success) {
    return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  }
  const input = parsed.data;

  // Replaying the same key is a duplicate submit, not a new receipt.
  if (input.idempotencyKey) {
    const existing = await prisma.batch.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true },
    });
    if (existing) {
      return success(`Batch #${existing.id} was already recorded (duplicate submission ignored).`);
    }
  }

  const product = await prisma.product.findUnique({
    where: { id: input.productId },
    select: { id: true, sku: true, unit: true },
  });
  if (!product) {
    return failure("That product no longer exists.", { productId: "Unknown product" });
  }

  try {
    const batch = await prisma.$transaction(async (tx) => {
      const created = await tx.batch.create({
        data: {
          productId: product.id,
          quantity: input.quantity,
          remainingQty: input.quantity,
          unitCost: new Prisma.Decimal(input.unitCost.toFixed(2)),
          receivedDate: parseDateOnly(input.receivedDate),
          notes: input.notes,
          idempotencyKey: input.idempotencyKey,
          createdBy: currentActor(),
        },
        select: { id: true },
      });

      await writeAudit(tx, {
        entityType: "batch",
        entityId: created.id,
        action: "batch.created",
        payload: {
          sku: product.sku,
          quantity: input.quantity,
          unitCost: input.unitCost,
          receivedDate: input.receivedDate,
        },
      });

      return created;
    });

    revalidateInventory();
    return success(
      `Batch #${batch.id} received: ${input.quantity} x ${product.sku} at ${input.unitCost.toFixed(2)} per ${product.unit}.`,
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Lost the race against a concurrent duplicate submit; that one won.
      return success("This batch was already recorded (duplicate submission ignored).");
    }
    console.error("createBatchAction failed", error);
    return failure("Could not save the batch. Please try again.");
  }
}

/**
 * Soft delete. The row stays so historical sales keep resolving their unit cost;
 * it just stops counting as stock and drops out of the dashboard.
 * Refused once the batch has sales attached, because removing it would silently
 * rewrite the profit on those sales.
 */
export async function softDeleteBatchAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = softDeleteSchema.safeParse({
    id: formData.get("id") ?? "",
    reason: formData.get("reason") ?? undefined,
  });
  if (!parsed.success) return failure("Invalid request.", zodFieldErrors(parsed.error));

  const { id, reason } = parsed.data;
  const batch = await prisma.batch.findUnique({
    where: { id },
    select: { id: true, isDeleted: true, _count: { select: { sales: true } } },
  });
  if (!batch) return failure("Batch not found.");
  if (batch.isDeleted) return success(`Batch #${id} is already removed.`);
  if (batch._count.sales > 0) {
    return failure(
      `Batch #${id} has ${batch._count.sales} sale(s) recorded against it and cannot be removed. Delete those sales first.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.batch.update({ where: { id }, data: { isDeleted: true } });
    await writeAudit(tx, {
      entityType: "batch",
      entityId: id,
      action: "batch.soft_deleted",
      payload: { reason },
    });
  });

  revalidateInventory();
  return success(`Batch #${id} removed from inventory.`);
}
