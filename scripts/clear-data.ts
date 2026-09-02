/**
 * Wipes operational data so you can start real bookkeeping from a clean slate.
 *
 *   npm run db:clear -- --yes                    # transactions + areas/shops
 *   npm run db:clear -- --yes --keep-geography   # keep areas and shops
 *   npm run db:clear                             # dry run: shows what WOULD go
 *
 * Always keeps: products, categories, and the migration history.
 * Never runs without --yes. This is destructive and there is no undo.
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

// Prisma's CLI loads .env; a plain tsx script does not.
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

type Counts = Record<string, number>;

async function counts(prisma: PrismaClient): Promise<Counts> {
  const rows = await prisma.$queryRawUnsafe<Counts[]>(`
    SELECT
      (SELECT COUNT(*)::int FROM products)         AS products,
      (SELECT COUNT(*)::int FROM categories)       AS categories,
      (SELECT COUNT(*)::int FROM areas)            AS areas,
      (SELECT COUNT(*)::int FROM shops)            AS shops,
      (SELECT COUNT(*)::int FROM batches)          AS batches,
      (SELECT COUNT(*)::int FROM sales)            AS sales,
      (SELECT COUNT(*)::int FROM bookings)         AS bookings,
      (SELECT COUNT(*)::int FROM audit_logs)       AS audit_logs,
      (SELECT COUNT(*)::int FROM invoice_counters) AS invoice_counters,
      (SELECT COUNT(*)::int FROM payments)         AS payments
  `);
  return rows[0];
}

function table(before: Counts, after: Counts | null): void {
  const keys = Object.keys(before);
  const w = Math.max(...keys.map((k) => k.length));
  console.log(`  ${"table".padEnd(w)}  before   after`);
  for (const k of keys) {
    const a = after ? String(after[k]) : "-";
    console.log(`  ${k.padEnd(w)}  ${String(before[k]).padStart(6)}  ${a.padStart(6)}`);
  }
}

async function main(): Promise<number> {
  loadDotEnv();

  const args = process.argv.slice(2);
  const confirmed = args.includes("--yes");
  const keepGeography = args.includes("--keep-geography");

  // Same reason as src/lib/db.ts: this deletes across ~14 statements in one
  // transaction, which at ~1s round-trip latency exceeds the 5s default.
  const prisma = new PrismaClient({
    log: ["error"],
    transactionOptions: { maxWait: 15_000, timeout: 60_000 },
  });

  try {
    const before = await counts(prisma);

    console.log("\nClearing operational data");
    console.log(`  keeping: products (${before.products}), categories (${before.categories})`);
    console.log(
      keepGeography
        ? `  keeping: areas (${before.areas}), shops (${before.shops})`
        : `  deleting: areas (${before.areas}), shops (${before.shops})`,
    );
    console.log("");

    if (!confirmed) {
      table(before, null);
      console.log("\nDRY RUN - nothing was deleted.");
      console.log("Re-run with --yes to actually delete:\n");
      console.log(
        `  npm run db:clear -- --yes${keepGeography ? " --keep-geography" : ""}\n`,
      );
      return 0;
    }

    // Order matters: every foreign key is onDelete: Restrict, so children go
    // before parents. One transaction, so a failure leaves the data untouched.
    await prisma.$transaction(async (tx) => {
      // Payments reference bookings with onDelete: Restrict, so they go first.
      await tx.$executeRawUnsafe(`DELETE FROM payments`);
      await tx.$executeRawUnsafe(`DELETE FROM sales`);
      await tx.$executeRawUnsafe(`DELETE FROM bookings`);
      await tx.$executeRawUnsafe(`DELETE FROM batches`);
      if (!keepGeography) {
        await tx.$executeRawUnsafe(`DELETE FROM shops`);
        await tx.$executeRawUnsafe(`DELETE FROM areas`);
      }
      await tx.$executeRawUnsafe(`DELETE FROM audit_logs`);
      // Invoice numbering restarts at INV-<year>-00001.
      await tx.$executeRawUnsafe(`DELETE FROM invoice_counters`);

      // Restart the id sequences so the first real batch is #1 again. Products
      // and categories keep their sequences, since their rows survive.
      const resets = ["sales", "bookings", "batches", "audit_logs", "payments"];
      if (!keepGeography) resets.push("shops", "areas");
      for (const t of resets) {
        await tx.$executeRawUnsafe(
          `SELECT setval(pg_get_serial_sequence('${t}', 'id'), 1, false)`,
        );
      }
    });

    const after = await counts(prisma);
    table(before, after);

    const survived = after.products === before.products && after.categories === before.categories;
    const cleared =
      after.sales === 0 &&
      after.bookings === 0 &&
      after.batches === 0 &&
      after.audit_logs === 0 &&
      after.invoice_counters === 0 &&
      after.payments === 0 &&
      (keepGeography || (after.areas === 0 && after.shops === 0));

    console.log("");
    if (!survived) {
      console.log("PROBLEM: products or categories changed. That should not happen.\n");
      return 1;
    }
    if (!cleared) {
      console.log("PROBLEM: something was not cleared. See the table above.\n");
      return 1;
    }

    console.log("Done. Products and categories kept; everything else cleared.");
    console.log("Ids restart at 1 and invoice numbering at INV-<year>-00001.");
    if (!keepGeography) {
      console.log("\nNext: add at least one area on /areas - a sale or booking needs one.");
    }
    console.log("");
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n").find((l) => l.trim()) : err;
    console.error(`\nFailed: ${message}\nNothing was deleted.\n`);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().then((code) => process.exit(code));
