import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Who / what / when for every stock movement.
 *
 * There is no auth yet, so the actor comes from DEFAULT_ACTOR. When you add
 * real logins, replace currentActor() with a session lookup and every existing
 * call site starts recording the real user with no other change.
 */
/**
 * Whose name goes on the audit row.
 *
 * Takes the signed-in person when there is one. Every action used to be
 * recorded as "owner" whoever did it, which was honest while one person had
 * the only password and becomes a lie the moment a booker signs in - and an
 * audit trail that cannot say who is useless at exactly the moment money has
 * gone missing.
 *
 * Still falls back, because jobs that nobody is signed in to - a script, the
 * seed, a scheduled task - still write rows.
 */
export function currentActor(user?: { name?: string } | null): string {
  return user?.name?.trim() || process.env.DEFAULT_ACTOR?.trim() || "owner";
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
  | "booker"
  | "user"
  | "booker_target";

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
    /**
     * Who did it. Required, and deliberately not defaulted.
     *
     * It used to fall back to currentActor(), which read an environment
     * variable - so every row in the log said "owner" no matter who was
     * signed in. That was honest while one person had the only password and
     * became a lie the day a second account existed, which is exactly when an
     * audit trail starts earning its keep.
     *
     * Required rather than resolved here on purpose, twice over. A default is
     * a thing a new call site gets silently and wrongly. And resolving it
     * would mean a database read inside whatever transaction is open, which
     * has already cost this codebase a broken Receive Stock page - the caller
     * reads it before the transaction, where it belongs.
     */
    actor: string;
    payload?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      actor: entry.actor,
      payload: entry.payload,
    },
  });
}
