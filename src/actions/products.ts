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
  updateProductSchema,
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

/**
 * A full catalog edit: category, name, packaging, variant, SKU, unit and price.
 *
 * None of it touches history. A sale stores the price it was sold at and gets
 * its cost from its batch, so renaming a product or correcting its packaging
 * relabels it everywhere without moving a single figure. That is the whole
 * reason profit is derived rather than stored.
 */
export async function updateProductAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = updateProductSchema.safeParse({
    id: formData.get("id") ?? "",
    categoryId: formData.get("categoryId") ?? "",
    name: formData.get("name") ?? "",
    packagingType: formData.get("packagingType") ?? "",
    variantValue: formData.get("variantValue") ?? "",
    sku: formData.get("sku") ?? "",
    unit: formData.get("unit") ?? "",
    defaultSalePrice: formData.get("defaultSalePrice") ?? "",
  });
  if (!parsed.success) {
    return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  }
  const { id, ...fields } = parsed.data;

  const existing = await prisma.product.findUnique({
    where: { id },
    select: {
      sku: true,
      name: true,
      categoryId: true,
      packagingType: true,
      variantValue: true,
      unit: true,
      defaultSalePrice: true,
    },
  });
  if (!existing) return failure("Product not found.");

  // Both unique indexes are checked up front: the SKU, and the
  // category+name+packaging+variant identity. Catching the violation after the
  // fact would work, but it rolls back a transaction for a predictable case and
  // cannot say which of the two collided.
  const [category, skuClash, identityClash] = await Promise.all([
    prisma.category.findUnique({ where: { id: fields.categoryId }, select: { id: true } }),
    prisma.product.findFirst({
      where: { sku: fields.sku, id: { not: id } },
      select: { id: true },
    }),
    prisma.product.findFirst({
      where: {
        categoryId: fields.categoryId,
        name: fields.name,
        packagingType: fields.packagingType,
        variantValue: fields.variantValue,
        id: { not: id },
      },
      select: { sku: true },
    }),
  ]);
  if (!category) return failure("That category no longer exists.", { categoryId: "Pick another" });
  if (skuClash) {
    return failure(`SKU "${fields.sku}" is already used by another product.`, {
      sku: "Already used",
    });
  }
  if (identityClash) {
    return failure(
      `${identityClash.sku} already has that exact category, name, packaging and variant.`,
      { name: "Already exists" },
    );
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id },
        data: {
          ...fields,
          defaultSalePrice: new Prisma.Decimal(fields.defaultSalePrice.toFixed(2)),
        },
      });
      await writeAudit(tx, {
        entityType: "product",
        entityId: id,
        action: "product.updated",
        payload: {
          before: { ...existing, defaultSalePrice: Number(existing.defaultSalePrice) },
          after: fields,
        },
      });
    });
    revalidateCatalog();
    return success(`${fields.sku} saved.`);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Two different unique indexes can reject this: the SKU, and the
      // category+name+packaging+variant identity. Say which.
      const target = String(error.meta?.target ?? "");
      return target.includes("sku")
        ? failure(`SKU "${fields.sku}" is already used by another product.`, {
            sku: "Already used",
          })
        : failure(
            "Another product already has that exact category, name, packaging and variant.",
            { name: "Already exists" },
          );
    }
    console.error("updateProductAction failed", error);
    return failure("Could not save the product.");
  }
}

/**
 * Delete a product outright. Only possible while nothing points at it.
 *
 * A product with batches or sales must be RETIRED instead: deleting it would
 * strip the label off historical stock and revenue. The button says so rather
 * than failing silently.
 */
export async function deleteProductAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = idOnlySchema.safeParse({ id: formData.get("id") ?? "" });
  if (!parsed.success) return failure("Invalid request.");
  const { id } = parsed.data;

  const product = await prisma.product.findUnique({
    where: { id },
    select: {
      id: true,
      sku: true,
      _count: { select: { batches: true, sales: true } },
    },
  });
  if (!product) return failure("Product not found.");

  const { batches, sales } = product._count;
  if (batches > 0 || sales > 0) {
    return failure(
      `${product.sku} has ${batches} batch(es) and ${sales} sale(s) against it, so it cannot be deleted. ` +
        "Retire it instead - it drops out of the pickers and keeps its history.",
    );
  }

  try {
    await prisma.$transaction(async (tx) => {
      await writeAudit(tx, {
        entityType: "product",
        entityId: id,
        action: "product.deleted",
        payload: { sku: product.sku },
      });
      await tx.product.delete({ where: { id } });
    });
    revalidateCatalog();
    return success(`${product.sku} deleted.`);
  } catch (error) {
    console.error("deleteProductAction failed", error);
    return failure("Could not delete the product.");
  }
}
