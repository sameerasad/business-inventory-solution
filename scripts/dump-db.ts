/**
 * Copy the live data out to a file, so the sandbox can be a realistic place to
 * work instead of a toy catalog.
 *
 *   npm run db:dump              -> .verify/data-dump.json
 *   npm run db:dump -- --out x   -> somewhere else
 *
 * Read-only. It runs SELECTs and nothing else, so it is safe to point at the
 * production database - which is the whole point of it.
 *
 * The file it writes contains real customer names and phone numbers, so it is
 * gitignored. Treat it the way you would treat a database backup, because that
 * is what it is.
 */
import fs from "node:fs";
import path from "node:path";

import { prisma } from "../src/lib/db";
import { hostOf, TABLE_ORDER, type Dump } from "./dump-shape";

async function main() {
  const outIndex = process.argv.indexOf("--out");
  const out =
    outIndex >= 0 && process.argv[outIndex + 1]
      ? process.argv[outIndex + 1]!
      : path.join(".verify", "data-dump.json");

  const sourceHost = hostOf(process.env.DATABASE_URL);
  console.log(`\nReading from ${sourceHost}\n`);

  const tables: Dump["tables"] = {};
  for (const table of TABLE_ORDER) {
    // Ordered by id so a restore is deterministic and diffable.
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "${table}" ORDER BY 1`,
    );
    tables[table] = rows;
    console.log(`  ${table.padEnd(18)} ${rows.length}`);
  }

  const dump: Dump = { takenAt: new Date().toISOString(), sourceHost, tables };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  // Prisma hands back Decimal and Date objects; both serialise to strings that
  // PostgreSQL accepts straight back on insert.
  //
  // BigInt does not serialise at all - JSON has no such type - and a bigint
  // column does exist here (the invoice counter). As a string it survives the
  // round trip, because PostgreSQL parses a numeric string back into bigint.
  fs.writeFileSync(
    out,
    JSON.stringify(
      dump,
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ),
  );

  const size = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(`\nWrote ${out} (${size} KB)`);
  console.log("This file holds real customer data. It is gitignored - keep it that way.\n");
}

main()
  .catch((error) => {
    console.error("\nDump failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
