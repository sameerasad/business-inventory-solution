"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import {
  createBookerSchema,
  failure,
  idOnlySchema,
  success,
  updateBookerSchema,
  zodFieldErrors,
  type ActionState,
} from "@/lib/validations";

function revalidateBookers() {
  revalidatePath("/bookers");
  revalidatePath("/bookings");
  revalidatePath("/bookings/new");
  revalidatePath("/dashboard");
}

export async function createBookerAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = createBookerSchema.safeParse({
    name: formData.get("name") ?? "",
    code: formData.get("code") ?? undefined,
    phone: formData.get("phone") ?? undefined,
    notes: formData.get("notes") ?? undefined,
  });
  if (!parsed.success) {
    return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  }
  const input = parsed.data;

  try {
    // A name that was removed earlier is restored rather than duplicated - the
    // unique index would reject the insert anyway.
    const existing = await prisma.booker.findUnique({
      where: { name: input.name },
      select: { id: true, isDeleted: true },
    });
    if (existing) {
      if (!existing.isDeleted) {
        return failure(`"${input.name}" is already a booker.`, { name: "Already exists" });
      }
      await prisma.$transaction(async (tx) => {
        await tx.booker.update({
          where: { id: existing.id },
          data: { isDeleted: false, isActive: true, ...input },
        });
        await writeAudit(tx, {
          entityType: "booker",
          entityId: existing.id,
          action: "booker.restored",
        });
      });
      revalidateBookers();
      return success(`Booker "${input.name}" restored.`);
    }

    const booker = await prisma.$transaction(async (tx) => {
      const created = await tx.booker.create({ data: input, select: { id: true } });
      await writeAudit(tx, {
        entityType: "booker",
        entityId: created.id,
        action: "booker.created",
        payload: { ...input },
      });
      return created;
    });
    revalidateBookers();
    return success(`Booker "${input.name}" added.`);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return failure(`"${input.name}" is already a booker.`, { name: "Already exists" });
    }
    console.error("createBookerAction failed", error);
    return failure("Could not add the booker. Please try again.");
  }
}

export async function updateBookerAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = updateBookerSchema.safeParse({
    id: formData.get("id") ?? "",
    name: formData.get("name") ?? "",
    code: formData.get("code") ?? undefined,
    phone: formData.get("phone") ?? undefined,
    notes: formData.get("notes") ?? undefined,
  });
  if (!parsed.success) {
    return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  }
  const { id, ...fields } = parsed.data;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.booker.update({ where: { id }, data: fields });
      await writeAudit(tx, {
        entityType: "booker",
        entityId: id,
        action: "booker.updated",
        payload: { ...fields },
      });
    });
    revalidateBookers();
    return success(`Booker "${fields.name}" saved.`);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return failure(`Another booker is already called "${fields.name}".`, {
        name: "Already exists",
      });
    }
    console.error("updateBookerAction failed", error);
    return failure("Could not save the booker.");
  }
}

/**
 * Retire or bring back a booker.
 *
 * This is the right tool for someone who has left: their bookings, and therefore
 * their history and the figures built on it, stay exactly as they are - they just
 * stop appearing in the booking form.
 */
export async function toggleBookerActiveAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = idOnlySchema.safeParse({ id: formData.get("id") ?? "" });
  if (!parsed.success) return failure("Invalid request.");

  const booker = await prisma.booker.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, name: true, isActive: true },
  });
  if (!booker) return failure("Booker not found.");

  const next = !booker.isActive;
  await prisma.$transaction(async (tx) => {
    await tx.booker.update({ where: { id: booker.id }, data: { isActive: next } });
    await writeAudit(tx, {
      entityType: "booker",
      entityId: booker.id,
      action: next ? "booker.reactivated" : "booker.retired",
    });
  });
  revalidateBookers();
  return success(`${booker.name} is now ${next ? "active" : "retired"}.`);
}

/**
 * Remove a booker entirely. Refused once they have bookings, because those
 * bookings would lose the attribution every performance figure is built on -
 * retire them instead.
 */
export async function deleteBookerAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = idOnlySchema.safeParse({ id: formData.get("id") ?? "" });
  if (!parsed.success) return failure("Invalid request.");
  const { id } = parsed.data;

  const booker = await prisma.booker.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      isDeleted: true,
      _count: { select: { bookings: true } },
    },
  });
  if (!booker) return failure("Booker not found.");
  if (booker.isDeleted) return success(`${booker.name} is already removed.`);
  if (booker._count.bookings > 0) {
    return failure(
      `${booker.name} has ${booker._count.bookings} booking(s) recorded and cannot be removed. Retire them instead - their history stays intact.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.booker.update({ where: { id }, data: { isDeleted: true, isActive: false } });
    await writeAudit(tx, { entityType: "booker", entityId: id, action: "booker.soft_deleted" });
  });
  revalidateBookers();
  return success(`Booker "${booker.name}" removed.`);
}
