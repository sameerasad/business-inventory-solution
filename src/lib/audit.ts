import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Who / what / when for every stock movement.
 *
 * There is no auth yet, so the actor comes from DEFAULT_ACTOR. When you add
 * real logins, replace currentActor() with a session lookup and every existing
 * call site starts recording the real user with no other change.
 */
export function currentActor(): string {
  return process.env.DEFAULT_ACTOR?.trim() || "owner";
}

export type AuditableEntity =
  | "batch"
  | "category"
  | "sale"
  | "product"
  | "area"
  | "shop"
  | "booking"
  | "payment"
  | "booker";

type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * Written inside the same transaction as the change it describes, so the log can
 * never disagree with the data.
 */
export async function writeAudit(
  tx: Tx,
  entry: {
    entityType: AuditableEntity;
    entityId: number;
    action: string;
    actor?: string;
    payload?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      actor: entry.actor ?? currentActor(),
      payload: entry.payload,
    },
  });
}
