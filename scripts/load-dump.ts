/**
 * Load a dump into whatever DATABASE_URL points at.
 *
 *   npm run db:load-dump
 *
 * This one WRITES, and it starts by emptying the target's business tables - so
 * it refuses to run against the host the dump came from, and against any host
 * that is not local, unless --force is given. Restoring a production dump onto
 * production is never what someone means by "load the dump", and the cost of
 * being wrong about that is the entire dataset.
 */
import fs from "node:fs";
import path from "node:path";

import { prisma } from "../src/lib/db";
import { hostOf, TABLE_ORDER, type Dump } from "./dump-shape";

const LOCAL_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

function isLocal(host: string): boolean {
  const withoutPort = host.split(":")[0] ?? host;
  return LOCAL_HOSTS.includes(withoutPort);
}

async function main() {
  const fileIndex = process.argv.indexOf("--file");
  const file =
    fileIndex >= 0 && process.argv[fileIndex + 1]
      ? process.argv[fileIndex + 1]!
      : path.join(".verify", "data-dump.json");
  const force = process.argv.includes("--force");

  if (!fs.existsSync(file)) {
    console.error(`\nNo dump at ${file}. Run: npm run db:dump\n`);
    process.exitCode = 1;
    return;
  }

  const dump = JSON.parse(fs.readFileSync(file, "utf8")) as Dump;
  const target = hostOf(process.env.DATABASE_URL);

  console.log(`\nDump   : ${file} (taken ${dump.takenAt} from ${dump.sourceHost})`);
  console.log(`Target : ${target}\n`);

  if (target === dump.sourceHost && !force) {
    console.error(
      "Refusing to load this dump back into the database it came from.\n" +
        "That would delete every row and reinsert the snapshot - losing anything\n" +
        "recorded since it was taken. Point DATABASE_URL at the sandbox instead.\n",
    );
    process.exitCode = 1;
    return;
  }
  if (!isLocal(target) && !force) {
    console.error(
      `Refusing to write to ${target}, which is not a local database.\n` +
        "This empties every business table first. If you genuinely mean to do it,\n" +
        "re-run with --force.\n",
    );
    process.exitCode = 1;
    return;
  }

  // One transaction: a half-loaded database with some tables emptied and others
  // populated is worse than either state.
  await prisma.$transaction(
    async (tx) => {
      // Children first, so nothing is deleted out from under a foreign key.
      for (const table of [...TABLE_ORDER].reverse()) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}"`);
      }

      for (const table of TABLE_ORDER) {
        const rows = dump.tables[table] ?? [];
        if (rows.length === 0) {
          console.log(`  ${table.padEnd(18)} 0`);
          continue;
        }

        // Every value in the dump is a string or a plain object - JSON has no
        // timestamp, no numeric and no bigint. A parameter arrives as text, and
        // PostgreSQL will not implicitly turn text into a timestamp, so each
        // placeholder is cast to the column's own type. Without this the very
        // first row fails on created_at.
        const types = await tx.$queryRawUnsafe<{ column_name: string; udt_name: string }[]>(
          `SELECT column_name, udt_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1`,
          table,
        );
        const typeOf = new Map(types.map((t) => [t.column_name, t.udt_name]));

        const columns = Object.keys(rows[0]!).filter((c) => typeOf.has(c));
        const quoted = columns.map((c) => `"${c}"`).join(", ");
        const placeholders = columns.map((c, i) => `$${i + 1}::${typeOf.get(c)}`).join(", ");
        const statement = `INSERT INTO "${table}" (${quoted}) VALUES (${placeholders})`;

        for (const row of rows) {
          const values = columns.map((c) => {
            const value = row[c];
            if (value == null) return null;
            // A json column comes back as an object and has to go out as text
            // for the ::jsonb cast to accept it.
            const udt = typeOf.get(c);
            if ((udt === "jsonb" || udt === "json") && typeof value === "object") {
              return JSON.stringify(value);
            }
            return value;
          });
          await tx.$executeRawUnsafe(statement, ...values);
        }
        console.log(`  ${table.padEnd(18)} ${rows.length}`);
      }

      // Identity columns keep their own counters, and inserting explicit ids
      // does not move them. Without this every new record collides with an
      // existing one on the primary key.
      //
      // Only tables that HAVE an id: pg_get_serial_sequence raises an error
      // rather than returning null when the column does not exist, and
      // booker_areas is keyed on (booker_id, area_id) with no id at all.
      const withIds = await tx.$queryRawUnsafe<{ table_name: string }[]>(
        `SELECT table_name FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'id'`,
      );
      const hasId = new Set(withIds.map((r) => r.table_name));

      for (const table of TABLE_ORDER) {
        if (!hasId.has(table)) continue;
        await tx.$executeRawUnsafe(
          `SELECT setval(
             pg_get_serial_sequence('"${table}"', 'id'),
             GREATEST(COALESCE((SELECT MAX(id) FROM "${table}"), 0), 1)
           ) WHERE pg_get_serial_sequence('"${table}"', 'id') IS NOT NULL`,
        );
      }
    },
    { timeout: 120_000, maxWait: 20_000 },
  );

  console.log("\nLoaded. Sequences reset, so new records continue from the right ids.\n");
}

main()
  .catch((error) => {
    console.error("\nLoad failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
