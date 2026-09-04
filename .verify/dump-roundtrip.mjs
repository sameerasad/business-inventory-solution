/**
 * Proves a dump can actually be restored.
 *
 * Boots an empty PGlite, applies every migration, loads the dump into it, and
 * checks the row counts match and that the id sequences were moved on - because
 * a restore where the next insert collides on the primary key is not a restore.
 *
 * Skips cleanly when there is no dump, so the suite still runs on a machine
 * that has never taken one.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { freePortFrom } from "./free-port.mjs";

const DUMP = path.join(process.cwd(), ".verify", "data-dump.json");
if (!fs.existsSync(DUMP)) {
  console.log("SKIP: no .verify/data-dump.json (run 'npm run db:dump' to create one)");
  process.exit(0);
}

const PG_PORT = await freePortFrom(54350, "database port");
const url =
  `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/postgres` +
  `?schema=public&statement_cache_size=0&connection_limit=5&pool_timeout=30`;

const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: PG_PORT, host: "127.0.0.1", maxConnections: 20 });
await server.start();

const env = { ...process.env, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url };

function run(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, stdio: "inherit", env });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

let failures = 0;
function ok(label, cond, detail) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}`, detail ?? "");
  }
}

try {
  console.log("\n=== restoring a dump into an empty database ===");
  if ((await run("npx prisma migrate deploy")) !== 0) throw new Error("migrate deploy failed");
  if ((await run("npx tsx scripts/load-dump.ts")) !== 0) throw new Error("load failed");

  const dump = JSON.parse(fs.readFileSync(DUMP, "utf8"));

  for (const [table, rows] of Object.entries(dump.tables)) {
    const { rows: counted } = await db.query(`SELECT COUNT(*)::int AS n FROM "${table}"`);
    ok(`${table}: ${rows.length} row(s) restored`, counted[0].n === rows.length, counted[0].n);
  }

  // The point of resetting sequences: an insert after a restore must not
  // collide with a row that came from the dump.
  const { rows: areas } = await db.query(
    `INSERT INTO areas (name, updated_at) VALUES ('Roundtrip Area', now()) RETURNING id`,
  );
  const maxDumped = Math.max(...dump.tables.areas.map((a) => Number(a.id)), 0);
  ok(
    `a new area gets an id past the restored ones (${areas[0].id} > ${maxDumped})`,
    areas[0].id > maxDumped,
    areas[0].id,
  );

  // Foreign keys have to have survived, or the data is decorative.
  const { rows: joined } = await db.query(
    `SELECT COUNT(*)::int AS n FROM sales s
     JOIN batches b ON b.id = s.batch_id
     JOIN products p ON p.id = s.product_id
     JOIN areas a ON a.id = s.area_id`,
  );
  ok(
    `every sale still joins to its batch, product and area (${joined[0].n})`,
    joined[0].n === dump.tables.sales.length,
    joined[0].n,
  );

  console.log(failures === 0 ? "\nROUNDTRIP OK" : `\n${failures} ROUNDTRIP FAILURES`);
} catch (error) {
  console.error(`\n${error.message}`);
  failures += 1;
} finally {
  try {
    await server.stop();
    await db.close();
  } catch {}
  process.exit(failures === 0 ? 0 : 1);
}
