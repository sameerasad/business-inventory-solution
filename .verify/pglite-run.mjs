// Boots a PGlite (Postgres-in-WASM) instance, applies the hand-written
// migrations, exposes it on a TCP socket, then runs the given commands against
// it with DATABASE_URL pointed at the socket.
//   node .verify/pglite-run.mjs "cmd one" "cmd two"
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const PORT = 54329;
const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?schema=public&connection_limit=1&pool_timeout=60&statement_cache_size=0`;
const migrationsDir = path.join(process.cwd(), "prisma", "migrations");

const db = await PGlite.create();

// Apply every migration in order, exactly as Postgres would.
const dirs = fs
  .readdirSync(migrationsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

for (const dir of dirs) {
  const file = path.join(migrationsDir, dir, "migration.sql");
  if (!fs.existsSync(file)) continue;
  const sql = fs.readFileSync(file, "utf8");
  try {
    await db.exec(sql);
    console.log(`migration OK  ${dir}`);
  } catch (err) {
    console.error(`migration FAILED  ${dir}`);
    console.error(err);
    process.exit(1);
  }
}

// Record them in Prisma's ledger so `prisma migrate status` sees a clean slate.
await db.exec(`
  CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    id                      VARCHAR(36) PRIMARY KEY NOT NULL,
    checksum                VARCHAR(64) NOT NULL,
    finished_at             TIMESTAMPTZ,
    migration_name          VARCHAR(255) NOT NULL,
    logs                    TEXT,
    rolled_back_at          TIMESTAMPTZ,
    started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_steps_count     INTEGER NOT NULL DEFAULT 0
  );
`);

const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1" });
await server.start();
console.log(`pglite listening on ${PORT}\n`);

// Must be async: spawnSync would block the event loop and the socket server
// would never get a chance to accept the incoming connection.
function run(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url, DEFAULT_ACTOR: "verify-runner" },
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

let failed = false;
for (const cmd of process.argv.slice(2)) {
  console.log(`\n$ ${cmd}`);
  const code = await run(cmd);
  if (code !== 0) {
    failed = true;
    console.error(`\n!! command failed with exit ${code}`);
    break;
  }
}

await server.stop();

// --- CHECK constraints, probed directly against PGlite ---
// These have to run outside the socket: a server-side error permanently closes
// the PGlite test socket, so Prisma cannot be used to trigger them.
console.log("\n=== db CHECK constraints (probed directly) ===");
const probes = [
  ["remaining_qty cannot go negative", `UPDATE batches SET remaining_qty = -5 WHERE id = 1`],
  [
    "remaining_qty cannot exceed quantity",
    `UPDATE batches SET remaining_qty = quantity + 1 WHERE id = 1`,
  ],
  [
    "batch quantity must be positive",
    `INSERT INTO batches (product_id, quantity, remaining_qty, unit_cost, received_date, updated_at)
     VALUES (1, 0, 0, 1.00, '2026-01-01', now())`,
  ],
  [
    "batch unit_cost cannot be negative",
    `INSERT INTO batches (product_id, quantity, remaining_qty, unit_cost, received_date, updated_at)
     VALUES (1, 10, 10, -1.00, '2026-01-01', now())`,
  ],
  [
    "sale quantity must be positive",
    `INSERT INTO sales (product_id, batch_id, area_id, quantity, sale_price, sale_date, updated_at)
     VALUES (1, 1, 1, 0, 1.00, '2026-01-01', now())`,
  ],
  [
    "sale_price cannot be negative",
    `INSERT INTO sales (product_id, batch_id, area_id, quantity, sale_price, sale_date, updated_at)
     VALUES (1, 1, 1, 1, -1.00, '2026-01-01', now())`,
  ],
  [
    "product default_sale_price cannot be negative",
    `UPDATE products SET default_sale_price = -1 WHERE id = 1`,
  ],
  [
    "two shops cannot share a name inside one area",
    `INSERT INTO shops (area_id, name, updated_at)
     SELECT area_id, name, now() FROM shops LIMIT 1`,
  ],
  ["a SKU cannot be reused", `INSERT INTO products (category_id, name, packaging_type, variant_value, sku, unit, updated_at)
     SELECT category_id, name, packaging_type, 'X', sku, unit, now() FROM products LIMIT 1`],
];

let constraintFailures = 0;

// The UPDATE probes target batch id 1 / product id 1. If those rows are absent
// the UPDATE matches nothing, raises no error, and would be scored as "the
// constraint let it through" - a false failure. Check the fixtures first.
const { rows: fixture } = await db.query(
  `SELECT (SELECT COUNT(*)::int FROM batches WHERE id = 1) AS b,
          (SELECT COUNT(*)::int FROM products WHERE id = 1) AS p,
          (SELECT COUNT(*)::int FROM shops) AS s`,
);
if (fixture[0].b === 0 || fixture[0].p === 0 || fixture[0].s === 0) {
  console.error(
    `  FAIL  constraint probes - fixtures missing (batch id 1: ${fixture[0].b}, ` +
      `product id 1: ${fixture[0].p}, shops: ${fixture[0].s}). These probes need ` +
      `the seed to have run and at least one batch to exist.`,
  );
  constraintFailures += 1;
} else {
  for (const [label, sql] of probes) {
    let blocked = false;
    let affected = null;
    try {
      await db.exec("BEGIN");
      const res = await db.query(sql);
      affected = res.affectedRows ?? null;
      await db.exec("ROLLBACK");
    } catch {
      blocked = true;
      await db.exec("ROLLBACK").catch(() => {});
    }
    if (blocked) {
      console.log(`  PASS  ${label}`);
    } else if (affected === 0) {
      // Nothing was written, so the constraint was never actually exercised.
      constraintFailures += 1;
      console.error(`  FAIL  ${label} - probe matched 0 rows, constraint not exercised`);
    } else {
      constraintFailures += 1;
      console.error(`  FAIL  ${label} - the write was ALLOWED`);
    }
  }
}
console.log(
  constraintFailures === 0
    ? `  ${probes.length}/${probes.length} constraint probes blocked as expected`
    : `  ${constraintFailures} constraint probe(s) did NOT block`,
);

await db.close();
process.exit(failed || constraintFailures > 0 ? 1 : 0);
