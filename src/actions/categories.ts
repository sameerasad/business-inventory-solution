"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import {
  categorySchema,
  failure,
  idOnlySchema,
  success,
  updateCategorySchema,
  zodFieldErrors,
  type ActionState,
} from "@/lib/validations";

function revalidateCatalog() {
  revalidatePath("/products");
  revalidatePath("/batches/new");
  revalidatePath("/dashboard");
}

/**
 * Categories are the top of the catalog: the dashboard's category split and the
 * product form's first choice both come from here.
 *
 * Unlike areas and products they are NOT soft-deleted. A category with no
 * products carries no history worth preserving, and the foreign key from
 * products is Restrict, so a category in use physically cannot vanish.
 */
export async function createCategoryAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = categorySchema.safeParse({ name: formData.get("name") ?? "" });
  if (!parsed.success) {
    return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  }
  const { name } = parsed.data;

  // Checked before the insert rather than caught after it. Letting the unique
  // index reject it works, but a failed statement inside an interactive
  // transaction is a rollback for a case that is entirely predictable - and the
  // message here can name the conflict.
  const clash = await prisma.category.findUnique({ where: { name }, select: { id: true } });
  if (clash) return failure(`Category "${name}" already exists.`, { name: "Already exists" });

  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.category.create({ data: { name }, select: { id: true } });
      await writeAudit(tx, {
        entityType: "category",
        entityId: row.id,
        action: "category.created",
        payload: { name },
      });
      return row;
    });
    revalidateCatalog();
    return success(`Category "${name}" added.`);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return failure(`Category "${name}" already exists.`, { name: "Already exists" });
    }
    console.error("createCategoryAction failed", error);
    return failure("Could not add the category. Please try again.");
  }
}

export async function renameCategoryAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = updateCategorySchema.safeParse({
    id: formData.get("id") ?? "",
    name: formData.get("name") ?? "",
  });
  if (!parsed.success) {
    return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  }
  const { id, name } = parsed.data;

  const [existing, clash] = await Promise.all([
    prisma.category.findUnique({ where: { id }, select: { name: true } }),
    prisma.category.findFirst({ where: { name, id: { not: id } }, select: { id: true } }),
  ]);
  if (!existing) return failure("Category not found.");
  if (clash) {
    return failure(`Another category is already called "${name}".`, { name: "Already exists" });
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.category.update({ where: { id }, data: { name } });
      await writeAudit(tx, {
        entityType: "category",
        entityId: id,
        action: "category.renamed",
        payload: { from: existing.name, to: name },
      });
    });
    revalidateCatalog();
    return success(`Category renamed to "${name}".`);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return failure(`Another category is already called "${name}".`, {
        name: "Already exists",
      });
    }
    console.error("renameCategoryAction failed", error);
    return failure("Could not rename the category.");
  }
}

/**
 * Delete a category. Refused while any product belongs to it - reassign or
 * remove those products first, so nothing is left pointing at nothing.
 */
export async function deleteCategoryAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = idOnlySchema.safeParse({ id: formData.get("id") ?? "" });
  if (!parsed.success) return failure("Invalid request.");
  const { id } = parsed.data;

  const category = await prisma.category.findUnique({
    where: { id },
    select: { id: true, name: true, _count: { select: { products: true } } },
  });
  if (!category) return failure("Category not found.");
  if (category._count.products > 0) {
    return failure(
      `"${category.name}" still has ${category._count.products} product(s) in it. ` +
        "Move them to another category first, or remove them.",
    );
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Audit first: once the row is gone the id means nothing, but the record
      // that it existed and was deleted is exactly what you want to keep.
      await writeAudit(tx, {
        entityType: "category",
        entityId: id,
        action: "category.deleted",
        payload: { name: category.name },
      });
      await tx.category.delete({ where: { id } });
    });
    revalidateCatalog();
    return success(`Category "${category.name}" deleted.`);
  } catch (error) {
    console.error("deleteCategoryAction failed", error);
    return failure("Could not delete the category.");
  }
}
