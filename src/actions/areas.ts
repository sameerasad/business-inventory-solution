"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import {
  areaSchema,
  failure,
  idOnlySchema,
  shopSchema,
  success,
  updateAreaSchema,
  updateShopSchema,
  zodFieldErrors,
  type ActionState,
} from "@/lib/validations";

function revalidateGeography() {
  revalidatePath("/areas");
  revalidatePath("/sales/new");
  revalidatePath("/sales");
  revalidatePath("/bookings/new");
  revalidatePath("/bookings");
  revalidatePath("/dashboard");
}

/* --------------------------------------------------------------------- areas */

export async function createAreaAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = areaSchema.safeParse({ name: formData.get("name") ?? "" });
  if (!parsed.success) return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  const { name } = parsed.data;

  try {
    // A previously removed area with the same name is restored rather than
    // duplicated, since the unique index on name would reject the insert anyway.
    const existing = await prisma.area.findUnique({ where: { name }, select: { id: true, isDeleted: true } });
    if (existing?.isDeleted) {
      await prisma.$transaction(async (tx) => {
        await tx.area.update({ where: { id: existing.id }, data: { isDeleted: false } });
        await writeAudit(tx, { entityType: "area", entityId: existing.id, action: "area.restored" });
      });
      revalidateGeography();
      return success(`Area "${name}" restored.`);
    }
    if (existing) return failure(`Area "${name}" already exists.`, { name: "Already exists" });

    const area = await prisma.$transaction(async (tx) => {
      const created = await tx.area.create({ data: { name }, select: { id: true } });
      await writeAudit(tx, {
        entityType: "area",
        entityId: created.id,
        action: "area.created",
        payload: { name },
      });
      return created;
    });

    revalidateGeography();
    return success(`Area "${name}" added.`);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return failure(`Area "${name}" already exists.`, { name: "Already exists" });
    }
    console.error("createAreaAction failed", error);
    return failure("Could not add the area. Please try again.");
  }
}

export async function renameAreaAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = updateAreaSchema.safeParse({
    id: formData.get("id") ?? "",
    name: formData.get("name") ?? "",
  });
  if (!parsed.success) return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  const { id, name } = parsed.data;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.area.update({ where: { id }, data: { name } });
      await writeAudit(tx, {
        entityType: "area",
        entityId: id,
        action: "area.renamed",
        payload: { name },
      });
    });
    revalidateGeography();
    return success(`Area renamed to "${name}".`);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return failure(`Another area is already called "${name}".`, { name: "Already exists" });
    }
    console.error("renameAreaAction failed", error);
    return failure("Could not rename the area.");
  }
}

/**
 * Soft delete. Refused while sales still point at the area, because those sales
 * would lose the label the dashboard groups them by.
 */
export async function deleteAreaAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = idOnlySchema.safeParse({ id: formData.get("id") ?? "" });
  if (!parsed.success) return failure("Invalid request.");
  const { id } = parsed.data;

  const area = await prisma.area.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      isDeleted: true,
      _count: { select: { sales: true } },
    },
  });
  if (!area) return failure("Area not found.");
  if (area.isDeleted) return success(`Area "${area.name}" is already removed.`);
  if (area._count.sales > 0) {
    return failure(
      `"${area.name}" has ${area._count.sales} sale(s) recorded against it, so it cannot be removed.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.area.update({ where: { id }, data: { isDeleted: true } });
    // Hiding an area must hide its shops too, or they would be orphaned in the picker.
    await tx.shop.updateMany({ where: { areaId: id }, data: { isDeleted: true } });
    await writeAudit(tx, { entityType: "area", entityId: id, action: "area.soft_deleted" });
  });

  revalidateGeography();
  return success(`Area "${area.name}" removed.`);
}

/* --------------------------------------------------------------------- shops */

/**
 * Shared by the Areas page and by the "add a shop without leaving this form"
 * dialog on the New Sale page, which is why it returns the shop id.
 */
export async function createShop(input: {
  areaId: number;
  name: string;
  address?: string | null;
  phone?: string | null;
}): Promise<
  | { ok: true; shopId: number; name: string; address: string | null; phone: string | null }
  | { ok: false; message: string }
> {
  const parsed = shopSchema.safeParse({
    areaId: String(input.areaId),
    name: input.name,
    address: input.address ?? undefined,
    phone: input.phone ?? undefined,
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid shop." };
  }
  const { areaId, name, address, phone } = parsed.data;

  const area = await prisma.area.findUnique({ where: { id: areaId }, select: { isDeleted: true } });
  if (!area || area.isDeleted) return { ok: false, message: "That area is no longer available." };

  try {
    // Upsert on (area, name): re-adding a removed shop restores it, and a
    // double-click cannot create two shops with the same name in one area.
    const shop = await prisma.$transaction(async (tx) => {
      const existing = await tx.shop.findUnique({
        where: { areaId_name: { areaId, name } },
        select: { id: true, isDeleted: true, address: true, phone: true },
      });
      if (existing) {
        // Re-adding a shop that already exists never blanks an address it
        // already has; an address given now fills a blank one in.
        const nextAddress = address ?? existing.address;
        const nextPhone = phone ?? existing.phone;
        if (
          existing.isDeleted ||
          nextAddress !== existing.address ||
          nextPhone !== existing.phone
        ) {
          await tx.shop.update({
            where: { id: existing.id },
            data: { isDeleted: false, address: nextAddress, phone: nextPhone },
          });
          await writeAudit(tx, {
            entityType: "shop",
            entityId: existing.id,
            action: existing.isDeleted ? "shop.restored" : "shop.details_updated",
          });
        }
        return { id: existing.id, address: nextAddress, phone: nextPhone };
      }
      const created = await tx.shop.create({
        data: { areaId, name, address, phone },
        select: { id: true, address: true, phone: true },
      });
      await writeAudit(tx, {
        entityType: "shop",
        entityId: created.id,
        action: "shop.created",
        payload: { areaId, name, address, phone },
      });
      return created;
    });

    revalidateGeography();
    return { ok: true, shopId: shop.id, name, address: shop.address, phone: shop.phone };
  } catch (error) {
    console.error("createShop failed", error);
    return { ok: false, message: "Could not add the shop. Please try again." };
  }
}

export async function createShopAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const areaIdRaw = String(formData.get("areaId") ?? "");
  const name = String(formData.get("name") ?? "");
  const address = String(formData.get("address") ?? "");
  const phone = String(formData.get("phone") ?? "");
  const areaId = Number.parseInt(areaIdRaw, 10);
  if (!Number.isInteger(areaId) || areaId <= 0) {
    return failure("Pick an area first.", { areaId: "Area is required" });
  }

  const result = await createShop({ areaId, name, address, phone });
  if (!result.ok) return failure(result.message, { name: result.message });
  return success(`Shop "${result.name}" added.`);
}

export async function renameShopAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = updateShopSchema.safeParse({
    id: formData.get("id") ?? "",
    name: formData.get("name") ?? "",
    address: formData.get("address") ?? undefined,
    phone: formData.get("phone") ?? undefined,
  });
  if (!parsed.success) return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  const { id, name, address, phone } = parsed.data;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.shop.update({ where: { id }, data: { name, address, phone } });
      await writeAudit(tx, {
        entityType: "shop",
        entityId: id,
        action: "shop.updated",
        payload: { name, address, phone },
      });
    });
    revalidateGeography();
    return success(`Shop "${name}" saved.`);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return failure(`That area already has a shop called "${name}".`, { name: "Already exists" });
    }
    console.error("renameShopAction failed", error);
    return failure("Could not rename the shop.");
  }
}

export async function deleteShopAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = idOnlySchema.safeParse({ id: formData.get("id") ?? "" });
  if (!parsed.success) return failure("Invalid request.");
  const { id } = parsed.data;

  const shop = await prisma.shop.findUnique({
    where: { id },
    select: { id: true, name: true, isDeleted: true, _count: { select: { sales: true } } },
  });
  if (!shop) return failure("Shop not found.");
  if (shop.isDeleted) return success(`Shop "${shop.name}" is already removed.`);
  if (shop._count.sales > 0) {
    return failure(
      `"${shop.name}" has ${shop._count.sales} sale(s) recorded against it, so it cannot be removed.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.shop.update({ where: { id }, data: { isDeleted: true } });
    await writeAudit(tx, { entityType: "shop", entityId: id, action: "shop.soft_deleted" });
  });

  revalidateGeography();
  return success(`Shop "${shop.name}" removed.`);
}
