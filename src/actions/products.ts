"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import {
  createProductSchema,
  deriveSku,
  failure,
  idOnlySchema,
  success,
  updateProductPriceSchema,
  zodFieldErrors,
  type ActionState,
} from "@/lib/validations";

function revalidateCatalog() {
  revalidatePath("/products");
  revalidatePath("/batches/new");
  revalidatePath("/sales/new");
  revalidatePath("/dashboard");
}

/**
 * Add a catalog entry - this is how new chocolate sizes (or a sixth flavor) get
 * in. SKU is optional: leave it blank and one is derived from
 * name + packaging + volume following the seeded convention (MNG-BTL-250).
 */
export async function createProductAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = createProductSchema.safeParse({
    categoryId: formData.get("categoryId") ?? "",
    name: formData.get("name") ?? "",
    packagingType: formData.get("packagingType") ?? "",
    variantValue: formData.get("variantValue") ?? "",
    sku: formData.get("sku") ?? undefined,
    unit: formData.get("unit") ?? "",
    defaultSalePrice: formData.get("defaultSalePrice") ?? "",
  });

  if (!parsed.success) {
    return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  }
  const input = parsed.data;
  const sku = input.sku ?? deriveSku(input);

  try {
    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          categoryId: input.categoryId,
          name: input.name,
          packagingType: input.packagingType,
          variantValue: input.variantValue,
          sku,
          unit: input.unit,
          defaultSalePrice: new Prisma.Decimal(input.defaultSalePrice.toFixed(2)),
        },
        select: { id: true, sku: true },
      });
      await writeAudit(tx, {
        entityType: "product",
        entityId: created.id,
        action: "product.created",
        payload: { sku: created.sku, name: input.name, unit: input.unit },
      });
      return created;
    });

    revalidateCatalog();
    return success(`Product ${product.sku} added to the catalog.`);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const target = String(error.meta?.target ?? "");
      if (target.includes("sku")) {
        return failure(`SKU ${sku} is already taken.`, { sku: "Already in use" });
      }
      return failure(
        "A product with that category, name, packaging and volume already exists.",
        { variantValue: "This combination already exists" },
      );
    }
    console.error("createProductAction failed", error);
    return failure("Could not add the product. Please try again.");
  }
}

/** Editing the default price never touches history - past sales keep their own price. */
export async function updateProductPriceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = updateProductPriceSchema.safeParse({
    productId: formData.get("productId") ?? "",
    defaultSalePrice: formData.get("defaultSalePrice") ?? "",
  });
  if (!parsed.success) {
    return failure("Please enter a valid price.", zodFieldErrors(parsed.error));
  }
  const { productId, defaultSalePrice } = parsed.data;

  const existing = await prisma.product.findUnique({
    where: { id: productId },
    select: { sku: true, defaultSalePrice: true },
  });
  if (!existing) return failure("Product not found.");

  await prisma.$transaction(async (tx) => {
    await tx.product.update({
      where: { id: productId },
      data: { defaultSalePrice: new Prisma.Decimal(defaultSalePrice.toFixed(2)) },
    });
    await writeAudit(tx, {
      entityType: "product",
      entityId: productId,
      action: "product.price_updated",
      payload: { from: Number(existing.defaultSalePrice), to: defaultSalePrice },
    });
  });

  revalidateCatalog();
  return success(`${existing.sku} default price set to ${defaultSalePrice.toFixed(2)}.`);
}

/**
 * Retire or restore a catalog entry. Inactive products drop out of the New Batch
 * and New Sale pickers but keep all their history.
 */
export async function toggleProductActiveAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = idOnlySchema.safeParse({ id: formData.get("id") ?? "" });
  if (!parsed.success) return failure("Invalid request.");

  const product = await prisma.product.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, sku: true, isActive: true },
  });
  if (!product) return failure("Product not found.");

  const next = !product.isActive;
  await prisma.$transaction(async (tx) => {
    await tx.product.update({ where: { id: product.id }, data: { isActive: next } });
    await writeAudit(tx, {
      entityType: "product",
      entityId: product.id,
      action: next ? "product.reactivated" : "product.retired",
    });
  });

  revalidateCatalog();
  return success(`${product.sku} is now ${next ? "active" : "retired"}.`);
}
