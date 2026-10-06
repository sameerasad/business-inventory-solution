"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { similarity } from "@/lib/voice/normalise";
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

/**
 * Areas whose name is near enough to be this one misspelt.
 *
 * The sales count comes back with them because it is the tell. "yousaf goth"
 * with six sales beside "yousuf goth" with one is not two localities - it is
 * one, entered twice, and the six is where the orders really went. A person
 * deciding between them needs that number more than they need the spelling.
 */
export async function findLookalikeAreas(name: string): Promise<Lookalike[]> {
  const wanted = fold(name);
  if (wanted.length < 3) return [];
  const areas = await prisma.area.findMany({
    where: { isDeleted: false },
    select: { id: true, name: true, _count: { select: { sales: true } } },
  });
  return areas
    .map((ar) => ({ ar, score: similarity(wanted, fold(ar.name)) }))
    .filter((x) => x.score >= 0.72 && fold(x.ar.name) !== wanted)
    .sort((x, y) => y.score - x.score)
    .map((x) => ({ id: x.ar.id, name: x.ar.name, sales: x.ar._count.sales }));
}

/**
 * Add an area, or recognise the one that is already there.
 *
 * Pulled out of the action because the order editor needs the id back, and
 * because areas had none of the protection shops have - the name column is
 * @unique and compares exactly, so "gulshan e saeed" and "Gulshan Saeed" are
 * both in the database today, one sale on each. A duplicate area is worse than
 * a duplicate shop: it splits a whole route, and the dashboard reports it as
 * two.
 */
export async function createArea(input: { name: string; confirmSimilar?: boolean }): Promise<
  | { ok: true; areaId: number; name: string; status: "created" | "restored" | "existing" }
  | { ok: false; message: string; similar?: Lookalike[] }
> {
  const parsed = areaSchema.safeParse({ name: input.name });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid area." };
  }
  const { name } = parsed.data;

  // Folded, not exact: the case-sensitive unique index is how the existing
  // pair got in.
  const all = await prisma.area.findMany({ select: { id: true, name: true, isDeleted: true } });
  const existing = all.find((ar) => fold(ar.name) === fold(name));

  if (existing?.isDeleted) {
    await prisma.$transaction(async (tx) => {
      await tx.area.update({ where: { id: existing.id }, data: { isDeleted: false } });
      await writeAudit(tx, { entityType: "area", entityId: existing.id, action: "area.restored" });
    });
    revalidateGeography();
    return { ok: true, areaId: existing.id, name: existing.name, status: "restored" };
  }
  if (existing) {
    return { ok: true, areaId: existing.id, name: existing.name, status: "existing" };
  }

  if (!input.confirmSimilar) {
    const similar = await findLookalikeAreas(name);
    if (similar.length > 0) {
      return {
        ok: false,
        message:
          `There is already ${similar.map((x) => `"${x.name}" (${x.sales} sales)`).join(" and ")}. ` +
          `Add "${name}" as a separate area only if it really is one.`,
        similar,
      };
    }
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.area.create({ data: { name }, select: { id: true } });
      await writeAudit(tx, { entityType: "area", entityId: row.id, action: "area.created", payload: { name } });
      return row;
    });
    revalidateGeography();
    return { ok: true, areaId: created.id, name, status: "created" };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: false, message: `Area "${name}" already exists.` };
    }
    console.error("createArea failed", error);
    return { ok: false, message: "Could not add the area. Please try again." };
  }
}

export async function createAreaAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const name = String(formData.get("name") ?? "");
  const confirmSimilar = String(formData.get("confirmSimilar") ?? "") === "true";
  const result = await createArea({ name, confirmSimilar });

  if (!result.ok) {
    return failure(result.message, {
      name: result.message,
      ...(result.similar?.length ? { similar: "1" } : {}),
    });
  }
  // Typing a name that is already there is a mistake worth reporting on this
  // page, even though the order editor treats the same answer as "that is the
  // area you meant" and just selects it.
  if (result.status === "existing") {
    return failure(`Area "${result.name}" already exists.`, { name: "Already exists" });
  }
  return success(
    result.status === "restored"
      ? `Area "${result.name}" restored.`
      : `Area "${result.name}" added.`,
  );
}

export async function renameAreaAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = updateAreaSchema.safeParse({
    id: formData.get("id") ?? "",
    name: formData.get("name") ?? "",
    voiceAlias: formData.get("voiceAlias") ?? undefined,
  });
  if (!parsed.success)
    return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  const { id, name, voiceAlias } = parsed.data;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.area.update({ where: { id }, data: { name, voiceAlias } });
      await writeAudit(tx, {
        entityType: "area",
        entityId: id,
        action: "area.renamed",
        payload: { name, voiceAlias },
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
/**
 * One name, for the purpose of deciding whether two shops are the same shop.
 *
 * The database constraint is @@unique([areaId, name]) and it compares exactly,
 * so "Ghousia Cosmetics" and "Ghousia cosmetics" are two different shops as
 * far as it is concerned - and both of them are sitting in laal market today,
 * created that way, neither with a sale against it.
 *
 * Deliberately its own small thing rather than the speech normaliser: that one
 * rewrites words to help a microphone, and whether two records are the same
 * record should not change because somebody edited the voice lexicon.
 */
function fold(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, " ")
    .trim()
    .replace(/s+/g, " ");
}

export type Lookalike = { id: number; name: string; sales: number };

/**
 * Shops in this area whose name is near enough to be the same shop misspelt.
 *
 * Near, not identical: an identical fold IS the same shop and is handled by
 * reusing it. This is for the pair a person has to look at - the real data has
 * "Imran Journal Store" and "Irfan Journal Store" one letter apart in one area,
 * and only a human knows whether that is two shopkeepers or one mishearing.
 */
export async function findLookalikeShops(areaId: number, name: string): Promise<Lookalike[]> {
  const wanted = fold(name);
  if (wanted.length < 3) return [];
  const shops = await prisma.shop.findMany({
    where: { areaId, isDeleted: false },
    select: { id: true, name: true, _count: { select: { sales: true } } },
  });
  return shops
    .map((sh) => ({ sh, score: similarity(wanted, fold(sh.name)) }))
    .filter((x) => x.score >= 0.72 && fold(x.sh.name) !== wanted)
    .sort((x, y) => y.score - x.score)
    .map((x) => ({ id: x.sh.id, name: x.sh.name, sales: x.sh._count.sales }));
}

export async function createShop(input: {
  areaId: number;
  name: string;
  address?: string | null;
  phone?: string | null;
  voiceAlias?: string | null;
  /** Set once a person has looked at the near-matches and meant it anyway. */
  confirmSimilar?: boolean;
}): Promise<
  | { ok: true; shopId: number; name: string; address: string | null; phone: string | null }
  | { ok: false; message: string; similar?: Lookalike[] }
> {
  const parsed = shopSchema.safeParse({
    areaId: String(input.areaId),
    name: input.name,
    address: input.address ?? undefined,
    phone: input.phone ?? undefined,
    voiceAlias: input.voiceAlias ?? undefined,
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid shop." };
  }
  const { areaId, name, address, phone, voiceAlias } = parsed.data;

  const area = await prisma.area.findUnique({ where: { id: areaId }, select: { isDeleted: true } });
  if (!area || area.isDeleted) return { ok: false, message: "That area is no longer available." };

  /**
   * A near-match is a question, not an error.
   *
   * Refusing outright would be wrong - "Imran Journal Store" and "Irfan Journal
   * Store" sit one letter apart in one area and may well be two shopkeepers. So
   * the first attempt comes back with what it found and the caller asks; a
   * second attempt carrying confirmSimilar goes through.
   *
   * Only when something would actually be CREATED. A name that folds onto an
   * existing shop is that shop, and reusing it is the fix rather than the risk.
   */
  if (!input.confirmSimilar) {
    const inArea = await prisma.shop.findMany({
      where: { areaId, isDeleted: false },
      select: { name: true },
    });
    const reusing = inArea.some((sh) => fold(sh.name) === fold(name));
    if (!reusing) {
      const similar = await findLookalikeShops(areaId, name);
      if (similar.length > 0) {
        return {
          ok: false,
          message:
            `This area already has ${similar.map((x) => `"${x.name}"`).join(" and ")}. ` +
            `Add "${name}" as a separate shop only if it really is one.`,
          similar,
        };
      }
    }
  }

  try {
    // Upsert on (area, name): re-adding a removed shop restores it, and a
    // double-click cannot create two shops with the same name in one area.
    const shop = await prisma.$transaction(async (tx) => {
      // Matched on the folded name, not the exact one. findUnique on
      // (areaId, name) compares byte for byte, which is how laal market ended
      // up with both "Ghousia Cosmetics" and "Ghousia cosmetics". A shop whose
      // name differs only in case or punctuation IS this shop, so it is reused
      // - and its existing spelling is kept rather than silently rewritten.
      const inArea = await tx.shop.findMany({
        where: { areaId },
        select: { id: true, name: true, isDeleted: true, address: true, phone: true, voiceAlias: true },
      });
      const wanted = fold(name);
      const existing = inArea.find((sh) => fold(sh.name) === wanted);
      if (existing) {
        // Re-adding a shop that already exists never blanks an address it
        // already has; an address given now fills a blank one in.
        const nextAddress = address ?? existing.address;
        const nextPhone = phone ?? existing.phone;
        const nextAlias = voiceAlias ?? existing.voiceAlias;
        if (
          existing.isDeleted ||
          nextAddress !== existing.address ||
          nextPhone !== existing.phone ||
          nextAlias !== existing.voiceAlias
        ) {
          await tx.shop.update({
            where: { id: existing.id },
            data: {
              isDeleted: false,
              address: nextAddress,
              phone: nextPhone,
              voiceAlias: nextAlias,
            },
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
        data: { areaId, name, address, phone, voiceAlias },
        select: { id: true, address: true, phone: true },
      });
      await writeAudit(tx, {
        entityType: "shop",
        entityId: created.id,
        action: "shop.created",
        payload: { areaId, name, address, phone, voiceAlias },
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
  const voiceAlias = String(formData.get("voiceAlias") ?? "");
  const areaId = Number.parseInt(areaIdRaw, 10);
  if (!Number.isInteger(areaId) || areaId <= 0) {
    return failure("Pick an area first.", { areaId: "Area is required" });
  }

  const confirmSimilar = String(formData.get("confirmSimilar") ?? "") === "true";
  const result = await createShop({ areaId, name, address, phone, voiceAlias, confirmSimilar });
  if (!result.ok) {
    // A separate key rather than sniffing the wording: the form needs to know
    // this refusal can be pressed through, and a message is for reading, not
    // for branching on.
    return failure(result.message, {
      name: result.message,
      ...(result.similar?.length ? { similar: "1" } : {}),
    });
  }
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
    voiceAlias: formData.get("voiceAlias") ?? undefined,
  });
  if (!parsed.success)
    return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  const { id, name, address, phone, voiceAlias } = parsed.data;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.shop.update({ where: { id }, data: { name, address, phone, voiceAlias } });
      await writeAudit(tx, {
        entityType: "shop",
        entityId: id,
        action: "shop.updated",
        payload: { name, address, phone, voiceAlias },
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

/**
 * Keep a phone number against the shop it belongs to.
 *
 * Exists because the WhatsApp dialog could not fill anything in: of sixty-five
 * shops, not one had a number stored, so every invoice meant typing it again.
 * The numbers were being typed - forty-eight orders carry one - they were just
 * being typed onto the order and then forgotten.
 *
 * Deliberately NOT done automatically from those orders. The same number
 * appears against ten different shops in the existing data, which is what a
 * test number or the owner's own phone looks like, and copying it onto ten
 * shops would be worse than leaving them empty: an autofilled wrong number
 * sends somebody's invoice to a stranger. So a person ticks the box.
 */
export async function saveShopPhoneAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = Number.parseInt(String(formData.get("shopId") ?? ""), 10);
  const phone = String(formData.get("phone") ?? "").trim();

  if (!Number.isInteger(id)) return failure("No shop to save this against.");
  if (phone.length < 7) return failure("That does not look like a phone number.");

  const shop = await prisma.shop.findUnique({ where: { id }, select: { name: true } });
  if (!shop) return failure("Shop not found.");

  try {
    await prisma.$transaction(async (tx) => {
      await tx.shop.update({ where: { id }, data: { phone } });
      await writeAudit(tx, {
        entityType: "shop",
        entityId: id,
        action: "shop.phone_saved",
        payload: { phone },
      });
    });
  } catch (error) {
    console.error("saveShopPhoneAction failed", error);
    return failure("Could not save the number.");
  }

  revalidateGeography();
  return success(`Saved. ${shop.name} will fill in next time.`);
}
