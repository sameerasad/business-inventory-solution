"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import { currentActor, writeAudit } from "@/lib/audit";
import { hashPassword } from "@/lib/auth";
import { denyNonAdmin } from "@/lib/guard";
import { currentUser } from "@/lib/session";
import {
  createUserSchema,
  failure,
  resetPasswordSchema,
  setTargetSchema,
  success,
  updateUserSchema,
  zodFieldErrors,
  type ActionState,
} from "@/lib/validations";
import { parseDateOnly } from "@/lib/dates";

function revalidateUsers() {
  revalidatePath("/users");
  revalidatePath("/my");
}

/**
 * Refuse to remove the last way back in.
 *
 * Demoting or deactivating the only remaining admin leaves an app whose own
 * owner cannot open the dashboard. There is a break-glass password for exactly
 * this, but needing it should be the result of losing a password, not of a
 * dropdown nobody thought twice about.
 */
async function wouldStrandTheApp(userId: number): Promise<boolean> {
  const otherAdmins = await prisma.user.count({
    where: { role: "admin", isActive: true, id: { not: userId } },
  });
  return otherAdmins === 0;
}

export async function createUserAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const denied = await denyNonAdmin();
  if (denied) return denied;

  const parsed = createUserSchema.safeParse({
    username: formData.get("username") ?? "",
    name: formData.get("name") ?? "",
    password: formData.get("password") ?? "",
    role: formData.get("role") ?? "",
    bookerId: formData.get("bookerId") ?? undefined,
  });
  if (!parsed.success) {
    return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  }
  const input = parsed.data;

  try {
    const passwordHash = await hashPassword(input.password);
    const actor = currentActor(await currentUser());

    await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          username: input.username,
          name: input.name,
          passwordHash,
          role: input.role,
          bookerId: input.bookerId,
        },
        select: { id: true },
      });
      await writeAudit(tx, {
        entityType: "user",
        entityId: created.id,
        action: "user.created",
        actor,
        // Never the password, and never the hash. An audit log is read by more
        // people than the users table is.
        payload: { username: input.username, name: input.name, role: input.role },
      });
    });

    revalidateUsers();
    return success(`${input.name} can now sign in as "${input.username}".`);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return failure(`The username "${input.username}" is already taken.`, {
        username: "Already taken",
      });
    }
    console.error("createUserAction failed", error);
    return failure("Could not create the account. Please try again.");
  }
}

export async function updateUserAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const denied = await denyNonAdmin();
  if (denied) return denied;

  const parsed = updateUserSchema.safeParse({
    id: formData.get("id") ?? "",
    name: formData.get("name") ?? "",
    role: formData.get("role") ?? "",
    bookerId: formData.get("bookerId") ?? undefined,
    isActive: formData.get("isActive") ?? undefined,
  });
  if (!parsed.success) {
    return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  }
  const input = parsed.data;

  const existing = await prisma.user.findUnique({
    where: { id: input.id },
    select: { id: true, username: true, role: true, isActive: true },
  });
  if (!existing) return failure("That account no longer exists.");

  const losingAdmin =
    existing.role === "admin" && (input.role !== "admin" || !input.isActive);
  if (losingAdmin && (await wouldStrandTheApp(existing.id))) {
    return failure(
      "This is the only active admin. Make somebody else an admin first, or nobody will be able to manage the app.",
    );
  }

  try {
    const actor = currentActor(await currentUser());

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: input.id },
        data: {
          name: input.name,
          role: input.role,
          bookerId: input.bookerId,
          isActive: input.isActive,
        },
      });
      await writeAudit(tx, {
        entityType: "user",
        entityId: input.id,
        action: "user.updated",
        actor,
        payload: {
          username: existing.username,
          role: input.role,
          isActive: input.isActive,
          bookerId: input.bookerId,
        },
      });
    });

    revalidateUsers();
    return success(`${input.name} updated.`);
  } catch (error) {
    console.error("updateUserAction failed", error);
    return failure("Could not save the account. Please try again.");
  }
}

/**
 * Set a new password for somebody.
 *
 * There is no "show me their current password" because there is no such thing
 * to show - only a hash is stored. An owner who is asked "what is my password"
 * can only ever answer by setting a new one, which is the correct answer.
 */
export async function resetPasswordAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const denied = await denyNonAdmin();
  if (denied) return denied;

  const parsed = resetPasswordSchema.safeParse({
    id: formData.get("id") ?? "",
    password: formData.get("password") ?? "",
  });
  if (!parsed.success) {
    return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  }
  const input = parsed.data;

  const existing = await prisma.user.findUnique({
    where: { id: input.id },
    select: { id: true, name: true, username: true },
  });
  if (!existing) return failure("That account no longer exists.");

  try {
    const passwordHash = await hashPassword(input.password);
    const actor = currentActor(await currentUser());

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: input.id }, data: { passwordHash } });
      await writeAudit(tx, {
        entityType: "user",
        entityId: input.id,
        action: "user.password_reset",
        actor,
        payload: { username: existing.username },
      });
    });

    // Not revalidated: nothing on the page changes, and the only thing worth
    // showing is the message telling the owner what to pass on.
    return success(`New password set for ${existing.name}. Tell them what it is.`);
  } catch (error) {
    console.error("resetPasswordAction failed", error);
    return failure("Could not set the password. Please try again.");
  }
}

/**
 * Set or clear one booker's target for one month.
 *
 * Upsert rather than create: a target is revised during the month more often
 * than it is set once, and a second attempt failing on a unique constraint
 * would read as "the app is broken" rather than "you already set this".
 */
export async function setTargetAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const denied = await denyNonAdmin();
  if (denied) return denied;

  const parsed = setTargetSchema.safeParse({
    bookerId: formData.get("bookerId") ?? "",
    month: formData.get("month") ?? "",
    amount: formData.get("amount") ?? undefined,
    packs: formData.get("packs") ?? undefined,
    notes: formData.get("notes") ?? undefined,
  });
  if (!parsed.success) {
    return failure("Please fix the highlighted fields.", zodFieldErrors(parsed.error));
  }
  const input = parsed.data;

  if (input.amount == null && input.packs == null) {
    return failure("Set an amount, a pack count, or both.", {
      amount: "One of these is required",
    });
  }

  // Whatever day was posted, a target belongs to a month. Normalised here so
  // the unique key means what it says and two "October" targets cannot exist.
  const day = parseDateOnly(input.month);
  const month = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));

  const booker = await prisma.booker.findUnique({
    where: { id: input.bookerId },
    select: { id: true, name: true, isDeleted: true },
  });
  if (!booker || booker.isDeleted) return failure("That booker no longer exists.");

  try {
    const actor = currentActor(await currentUser());

    await prisma.$transaction(async (tx) => {
      const saved = await tx.bookerTarget.upsert({
        where: { bookerId_month: { bookerId: input.bookerId, month } },
        create: {
          bookerId: input.bookerId,
          month,
          amount: input.amount,
          packs: input.packs,
          notes: input.notes,
          createdBy: actor,
        },
        update: { amount: input.amount, packs: input.packs, notes: input.notes },
        select: { id: true },
      });
      await writeAudit(tx, {
        entityType: "booker_target",
        entityId: saved.id,
        action: "target.set",
        actor,
        payload: {
          bookerId: input.bookerId,
          month: month.toISOString().slice(0, 10),
          amount: input.amount,
          packs: input.packs,
        },
      });
    });

    revalidateUsers();
    return success(`Target saved for ${booker.name}.`);
  } catch (error) {
    console.error("setTargetAction failed", error);
    return failure("Could not save the target. Please try again.");
  }
}
