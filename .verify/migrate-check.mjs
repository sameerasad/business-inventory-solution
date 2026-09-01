// Runs the real `prisma migrate deploy` against an empty database, the way the
// README tells you to, then confirms the tables and constraints exist.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const migrationsDir = path.join(process.cwd(), "prisma", "migrations");

const PORT = 54340;
const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?schema=public&connection_limit=1&statement_cache_size=0`;
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1" });
await server.start();

const code = await new Promise((res) => {
  const c = spawn("npx prisma migrate deploy", {
    shell: true, stdio: "inherit", env: { ...process.env, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url },
  });
  c.on("exit", (x) => res(x ?? 1));
});

await server.stop();

const tables = await db.query(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`,
);
const checks = await db.query(
  `SELECT conname FROM pg_constraint WHERE contype='c' AND connamespace='public'::regnamespace ORDER BY 1`,
);
const applied = await db.query(`SELECT migration_name FROM _prisma_migrations ORDER BY 1`);
console.log("\ntables:", tables.rows.map((r) => r.table_name).join(", "));
console.log("check constraints:", checks.rows.length);
console.log("migrations recorded:", applied.rows.map((r) => r.migration_name).join(", "));

const EXPECTED_TABLES = [
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
const missingTables = EXPECTED_TABLES.filter(
  (t) => !tables.rows.some((r) => r.table_name === t),
);
if (missingTables.length) console.error("missing tables:", missingTables.join(", "));

// Counted from the filesystem, not hardcoded, so adding a migration cannot
// silently make this check stale.
const expectedMigrations = fs
  .readdirSync(migrationsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(migrationsDir, d.name, "migration.sql")))
  .length;
if (applied.rows.length !== expectedMigrations) {
  console.error(
    `recorded ${applied.rows.length} migration(s) but ${expectedMigrations} exist on disk`,
  );
}

const ok =
  code === 0 &&
  missingTables.length === 0 &&
  checks.rows.length >= 7 &&
  applied.rows.length === expectedMigrations;
await db.close();
console.log(ok ? "\nMIGRATE DEPLOY OK" : "\nMIGRATE DEPLOY FAILED");
process.exit(ok ? 0 : 1);
