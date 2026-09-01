import { PrismaClient } from "@prisma/client";

// Next.js dev mode hot-reloads modules, which would otherwise open a new pool on
// every reload until Postgres refuses connections. Cache the client on globalThis.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],

    /**
     * Prisma's default interactive-transaction timeout is 5 seconds, which
     * assumes the database is nearby. Every write in this app is one
     * transaction containing many statements - a booking does a findMany, a
     * guarded updateMany and a create per batch it touches, plus the invoice
     * counter and the audit row - so the statement count multiplies whatever
     * the round-trip latency happens to be.
     *
     * At ~1s per round trip (a laptop on another continent from the database) a
     * three-line booking needs about 20 seconds, and the default silently
     * aborts it mid-way with "Transaction not found". These limits are
     * generous enough that latency, not the timeout, decides the outcome.
     * They do not slow anything down: a transaction still finishes as soon as
     * its work is done.
     */
    transactionOptions: {
      maxWait: 15_000,
      timeout: 60_000,
    },
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
