/**
 * Finds and optionally repairs payments that no live sale backs.
 *
 *   npm run db:check-payments             # report only
 *   npm run db:check-payments -- --fix    # reverse the unmatched payments
 *
 * "Unmatched" means a booking whose recorded payments exceed the value of its
 * live sales. Through the app that is impossible; it happens when sales are
 * removed directly in the database, or a booking is cancelled by an older
 * version that did not reverse its payments.
 *
 * --fix soft-deletes those payments (they stay in the table, flagged) and writes
 * an audit entry, so the reversal is itself traceable.
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

function loadDotEnv(file = ".env"): void {
  const full = path.join(process.cwd(), file);
  if (!fs.existsSync(full)) return;
  for (const raw of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

type Anomaly = {
  id: number;
  invoiceNo: string;
  cancelled: boolean;
  saleValue: number;
  paid: number;
  excess: number;
};

async function main(): Promise<number> {
  loadDotEnv();
  const fix = process.argv.includes("--fix");

  const prisma = new PrismaClient({
    log: ["error"],
    transactionOptions: { maxWait: 15_000, timeout: 60_000 },
  });

  try {
    const anomalies = await prisma.$queryRawUnsafe<Anomaly[]>(`
      SELECT
        b.id                                       AS "id",
        b.invoice_no                               AS "invoiceNo",
        b.is_deleted                               AS "cancelled",
        COALESCE(t.total, 0)::float8               AS "saleValue",
        pay.paid::float8                           AS "paid",
        (pay.paid - COALESCE(t.total, 0))::float8  AS "excess"
      FROM bookings b
      JOIN (
        SELECT p.booking_id, SUM(p.amount) AS paid
        FROM payments p WHERE p.is_deleted = false
        GROUP BY p.booking_id
      ) pay ON pay.booking_id = b.id
      LEFT JOIN (
        SELECT s.booking_id, SUM(s.sale_price * s.quantity) AS total
        FROM sales s WHERE s.is_deleted = false AND s.booking_id IS NOT NULL
        GROUP BY s.booking_id
      ) t ON t.booking_id = b.id
      WHERE pay.paid - COALESCE(t.total, 0) > 0.005
      ORDER BY (pay.paid - COALESCE(t.total, 0)) DESC
    `);

    const totals = await prisma.$queryRawUnsafe<{ invoiced: number; collected: number }[]>(`
      SELECT
        COALESCE((
          SELECT SUM(s.sale_price * s.quantity)
          FROM sales s JOIN bookings b ON b.id = s.booking_id
          WHERE s.is_deleted = false AND b.is_deleted = false
        ), 0)::float8 AS invoiced,
        COALESCE((
          SELECT SUM(p.amount)
          FROM payments p JOIN bookings b ON b.id = p.booking_id
          WHERE p.is_deleted = false AND b.is_deleted = false
        ), 0)::float8 AS collected
    `);

    console.log("\nPayment integrity check\n");
    console.log(`  Invoiced (live bookings)  ${totals[0].invoiced.toFixed(2)}`);
    console.log(`  Collected (live bookings) ${totals[0].collected.toFixed(2)}`);
    console.log("");

    if (anomalies.length === 0) {
      console.log("  [ok]  every payment is backed by sales of at least that value.\n");
      return 0;
    }

    console.log(`  ${anomalies.length} booking(s) with unmatched payments:\n`);
    for (const a of anomalies) {
      console.log(
        `    ${a.invoiceNo}${a.cancelled ? " (CANCELLED)" : ""}\n` +
          `      live sales ${a.saleValue.toFixed(2)}, paid ${a.paid.toFixed(2)}, ` +
          `unmatched ${a.excess.toFixed(2)}`,
      );
    }
    const excess = anomalies.reduce((sum, a) => sum + a.excess, 0);
    console.log(`\n  Total unmatched: ${excess.toFixed(2)}`);

    if (!fix) {
      console.log("\n  Report only. To reverse these payments:\n");
      console.log("    npm run db:check-payments -- --fix\n");
      console.log("  Reversal is a soft delete: the rows stay, flagged, and are audited.\n");
      return 1;
    }

    // Reverse only the payments on the affected bookings, newest first, and only
    // as many as it takes to remove the excess - a booking that is genuinely
    // part-paid keeps the payments its sales justify.
    let reversed = 0;
    let reversedAmount = 0;

    for (const a of anomalies) {
      const payments = await prisma.payment.findMany({
        where: { bookingId: a.id, isDeleted: false },
        orderBy: [{ paidOn: "desc" }, { id: "desc" }],
        select: { id: true, amount: true },
      });

      let toRemove = a.excess;
      for (const p of payments) {
        if (toRemove <= 0.005) break;
        const amount = Number(p.amount);
        await prisma.$transaction(async (tx) => {
          await tx.payment.update({ where: { id: p.id }, data: { isDeleted: true } });
          await tx.auditLog.create({
            data: {
              entityType: "payment",
              entityId: p.id,
              action: "payment.reversed",
              actor: process.env.DEFAULT_ACTOR?.trim() || "owner",
              payload: {
                reason: "unmatched payment - no live sales behind it",
                invoiceNo: a.invoiceNo,
                amount,
                viaScript: "db:check-payments --fix",
              },
            },
          });
        });
        toRemove -= amount;
        reversed += 1;
        reversedAmount += amount;
        console.log(`    reversed ${amount.toFixed(2)} on ${a.invoiceNo}`);
      }
    }

    console.log(`\n  Reversed ${reversed} payment(s) totalling ${reversedAmount.toFixed(2)}.`);

    const after = await prisma.$queryRawUnsafe<{ n: number }[]>(`
      SELECT COUNT(*)::int AS n FROM (
        SELECT b.id
        FROM bookings b
        JOIN (
          SELECT p.booking_id, SUM(p.amount) AS paid
          FROM payments p WHERE p.is_deleted = false GROUP BY p.booking_id
        ) pay ON pay.booking_id = b.id
        LEFT JOIN (
          SELECT s.booking_id, SUM(s.sale_price * s.quantity) AS total
          FROM sales s WHERE s.is_deleted = false AND s.booking_id IS NOT NULL
          GROUP BY s.booking_id
        ) t ON t.booking_id = b.id
        WHERE pay.paid - COALESCE(t.total, 0) > 0.005
      ) x
    `);
    if (after[0].n === 0) {
      console.log("  [ok]  no unmatched payments remain.\n");
      return 0;
    }
    console.log(`  [FAIL] ${after[0].n} still unmatched - re-run to see them.\n`);
    return 1;
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n").find((l) => l.trim()) : err;
    console.error(`\nFailed: ${message}\n`);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().then((code) => process.exit(code));
