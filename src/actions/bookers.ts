"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import {
  createBookerSchema,
  failure,
  idOnlySchema,
  setBookerAreasSchema,
  success,
  updateBookerSchema,
  zodFieldErrors,
  type ActionState,
} from "@/lib/validations";

function revalidateBookers() {
  revalidatePath("/bookers");
  revalidatePath("/areas");
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

/**
 * Replace a booker's territory with exactly the areas given.
 *
 * Replace, not add: the form shows the full list with the current areas ticked,
 * so what it posts IS the new territory. Doing it in one transaction means a
 * half-applied territory can never be read by the reports.
 *
 * Assignment is deliberately advisory. It does not stop the booker taking an
 * order in an area that is not theirs - covering for someone off sick is normal
 * - it just means that order shows up as off-territory in the reports.
 */
export async function setBookerAreasAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = setBookerAreasSchema.safeParse({
    bookerId: formData.get("bookerId") ?? "",
    areaIds: formData.get("areaIds") ?? "",
  });
  if (!parsed.success) {
    return failure("Could not save the territory.", zodFieldErrors(parsed.error));
  }
  const { bookerId, areaIds } = parsed.data;

  const booker = await prisma.booker.findUnique({
    where: { id: bookerId },
    select: { id: true, name: true, isDeleted: true },
  });
  if (!booker || booker.isDeleted) return failure("Booker not found.");

  // Silently dropping an id that names a deleted area would look like the save
  // failed, so the mismatch is reported instead.
  const areas = areaIds.length
    ? await prisma.area.findMany({
        where: { id: { in: areaIds }, isDeleted: false },
        select: { id: true },
      })
    : [];
  if (areas.length !== areaIds.length) {
    return failure("One of those areas no longer exists. Reload the page and try again.");
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.bookerArea.deleteMany({ where: { bookerId } });
      if (areas.length > 0) {
        await tx.bookerArea.createMany({
          data: areas.map((a) => ({ bookerId, areaId: a.id })),
        });
      }
      await writeAudit(tx, {
        entityType: "booker",
        entityId: bookerId,
        action: "booker.areas_assigned",
        payload: { areaIds: areas.map((a) => a.id) },
      });
    });
  } catch (error) {
    console.error("setBookerAreasAction failed", error);
    return failure("Could not save the territory. Please try again.");
  }

  revalidateBookers();
  return success(
    areas.length === 0
      ? `${booker.name} now has no areas assigned.`
      : `${booker.name} now covers ${areas.length} area${areas.length === 1 ? "" : "s"}.`,
  );
}
