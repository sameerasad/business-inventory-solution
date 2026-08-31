// Runs the real `prisma migrate deploy` against an empty database, the way the
// README tells you to, then confirms the tables and constraints exist.
import { spawn } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

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

const okTables = ["areas","audit_logs","batches","categories","products","sales","shops"]
  .every((t) => tables.rows.some((r) => r.table_name === t));
const ok = code === 0 && okTables && checks.rows.length >= 7 && applied.rows.length === 2;
await db.close();
console.log(ok ? "\nMIGRATE DEPLOY OK" : "\nMIGRATE DEPLOY FAILED");
process.exit(ok ? 0 : 1);
