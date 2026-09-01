/**
 * Rehearses the production repair on a throwaway database.
 *
 * Reproduces exactly what happened to the live Neon database - someone dropped
 * areas, shops, batches, sales and audit_logs - then runs `npm run db:repair`
 * and checks that the schema comes back intact AND that edited product prices
 * survive. Touches nothing real.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const PORT = 54355;
const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?schema=public&statement_cache_size=0&connection_limit=1&pool_timeout=60`;

let checks = 0;
let failures = 0;
function ok(label, cond, detail) {
  checks += 1;
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}`, detail ?? "");
  }
}

// The tables the app expects, and the ones this rehearsal drops. Derived
// assertions, so adding a table to the schema cannot silently stale this file.
const ALL_TABLES = [
  "areas",
  "audit_logs",
  "batches",
  "bookings",
  "categories",
  "invoice_counters",
  "products",
  "sales",
  "shops",
];
const DROPPED = ["sales", "batches", "shops", "areas", "audit_logs"];
const SURVIVORS = ALL_TABLES.filter((t) => !DROPPED.includes(t));

const db = await PGlite.create();
const migrationsDir = path.join(process.cwd(), "prisma", "migrations");
for (const d of fs
  .readdirSync(migrationsDir, { withFileTypes: true })
  .filter((x) => x.isDirectory())
  .map((x) => x.name)
  .sort()) {
  await db.exec(fs.readFileSync(path.join(migrationsDir, d, "migration.sql"), "utf8"));
}
// Prisma's ledger - this is what makes `migrate deploy` a no-op after a manual
// DROP, which is the trap we are working around. The rows must actually be
// present (with correct checksums) for `migrate status` to report "up to date",
// exactly as the production database does.
await db.exec(`
  CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    id VARCHAR(36) PRIMARY KEY NOT NULL,
    checksum VARCHAR(64) NOT NULL,
    finished_at TIMESTAMPTZ,
    migration_name VARCHAR(255) NOT NULL,
    logs TEXT,
    rolled_back_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_steps_count INTEGER NOT NULL DEFAULT 0
  );
`);

// Mark both migrations as applied, mirroring the live database.
const crypto = await import("node:crypto");
for (const d of fs
  .readdirSync(migrationsDir, { withFileTypes: true })
  .filter((x) => x.isDirectory())
  .map((x) => x.name)
  .sort()) {
  const sql = fs.readFileSync(path.join(migrationsDir, d, "migration.sql"), "utf8");
  const checksum = crypto.createHash("sha256").update(sql).digest("hex");
  await db.query(
    `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, finished_at, applied_steps_count)
     VALUES ($1, $2, $3, now(), 1)`,
    [crypto.randomUUID(), checksum, d],
  );
}

const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
await server.start();

function run(cmd, label) {
  return new Promise((resolve) => {
    console.log(`\n$ ${label ?? cmd}`);
    const child = spawn(cmd, {
      shell: true,
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: url,
        DATABASE_URL_UNPOOLED: url,
        DEFAULT_ACTOR: "rehearsal",
      },
    });
    child.on("exit", (c) => resolve(c ?? 1));
  });
}

const tableList = async () => {
  const { rows } = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name NOT LIKE '\\_prisma%'
      ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
};
const constraintCount = async () => {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM pg_constraint WHERE contype = 'c' AND conname LIKE ANY (ARRAY['batches%','sales%','products%'])`,
  );
  return rows[0].n;
};

try {
  console.log("\n=== 1. healthy database, with an edited price ===");
  await run("npx tsx prisma/seed.ts", "seed");
  // Stand in for the real edited prices (CHO-BAR-10=10, APP-BTL-250=450, ...).
  await db.exec(`UPDATE products SET default_sale_price = 450 WHERE sku = 'APP-BTL-250'`);
  await db.exec(`UPDATE products SET default_sale_price = 10 WHERE sku = 'CHO-BAR-10'`);
  ok(
    `all ${ALL_TABLES.length} tables present`,
    (await tableList()).join(",") === ALL_TABLES.join(","),
    await tableList(),
  );
  ok("7 CHECK constraints present", (await constraintCount()) === 7, await constraintCount());

  console.log("\n=== 2. reproduce the damage (DROP ... CASCADE) ===");
  await db.exec(`
    DROP TABLE IF EXISTS "sales" CASCADE;
    DROP TABLE IF EXISTS "batches" CASCADE;
    DROP TABLE IF EXISTS "shops" CASCADE;
    DROP TABLE IF EXISTS "areas" CASCADE;
    DROP TABLE IF EXISTS "audit_logs" CASCADE;
  `);
  const damaged = await tableList();
  ok(
    `only ${SURVIVORS.join(", ")} left`,
    damaged.join(",") === SURVIVORS.join(","),
    damaged,
  );

  console.log("\n=== 3. confirm `migrate deploy` does NOT fix it (the trap) ===");
  const statusCode = await run("npx prisma migrate status", "prisma migrate status");
  ok("ledger reports up to date (exit 0) despite 5 missing tables", statusCode === 0, statusCode);
  const deployCode = await run("npx prisma migrate deploy", "prisma migrate deploy");
  ok("migrate deploy exits 0 but fixes nothing", deployCode === 0, deployCode);
  ok(
    "tables STILL missing after migrate deploy",
    (await tableList()).length === SURVIVORS.length,
    await tableList(),
  );

  console.log("\n=== 4. run the repair ===");
  const repairCode = await run("npm run db:repair", "npm run db:repair");
  ok("db:repair exited 0", repairCode === 0, repairCode);

  console.log("\n=== 5. verify recovery ===");
  const after = await tableList();
  ok(`all ${ALL_TABLES.length} tables restored`, after.join(",") === ALL_TABLES.join(","), after);
  ok("all 7 CHECK constraints restored", (await constraintCount()) === 7, await constraintCount());

  const { rows: idx } = await db.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN ('batches_available_idx','sales_live_by_date_idx') ORDER BY indexname`,
  );
  ok("both partial indexes restored", idx.length === 2, idx);

  const { rows: prices } = await db.query(
    `SELECT sku, default_sale_price::float8 AS p FROM products WHERE sku IN ('APP-BTL-250','CHO-BAR-10') ORDER BY sku`,
  );
  ok(
    "EDITED PRICES SURVIVED the repair",
    prices.length === 2 && prices[0].p === 450 && prices[1].p === 10,
    prices,
  );

  const { rows: geo } = await db.query(
    `SELECT (SELECT COUNT(*)::int FROM areas) AS a, (SELECT COUNT(*)::int FROM shops) AS s`,
  );
  ok("areas and shops re-seeded", geo[0].a === 4 && geo[0].s === 7, geo[0]);

  console.log("\n=== 6. the guards actually work again ===");
  let blocked = false;
  try {
    await db.exec(
      `BEGIN; INSERT INTO batches (product_id, quantity, remaining_qty, unit_cost, received_date, updated_at)
       VALUES (1, 10, -1, 1.00, '2026-01-01', now()); ROLLBACK;`,
    );
  } catch {
    blocked = true;
  }
  await db.exec("ROLLBACK").catch(() => {});
  ok("negative remaining_qty rejected again", blocked);

  console.log(`\n${checks - failures}/${checks} rehearsal checks passed`);
} catch (err) {
  failures += 1;
  console.error(err);
} finally {
  await server.stop();
  await db.close();
}

process.exit(failures ? 1 : 0);
