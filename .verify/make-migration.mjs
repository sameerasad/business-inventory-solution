/**
 * Generates a new migration.sql by diffing schema.prisma against a shadow
 * database that has only the EXISTING migrations applied.
 *
 *   node .verify/make-migration.mjs <migration_folder_name>
 *
 * Using `prisma migrate diff` rather than hand-writing the SQL means the
 * generated DDL uses Prisma's own index/constraint naming, so a later
 * `migrate diff` drift check stays clean.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const name = process.argv[2];
if (!name) {
  console.error("usage: node .verify/make-migration.mjs <migration_folder_name>");
  process.exit(1);
}

const PORT = 54360;
const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?schema=public&statement_cache_size=0&connection_limit=1`;
const migrationsDir = path.join(process.cwd(), "prisma", "migrations");

const db = await PGlite.create();
const existing = fs
  .readdirSync(migrationsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

for (const dir of existing) {
  const file = path.join(migrationsDir, dir, "migration.sql");
  if (fs.existsSync(file)) {
    await db.exec(fs.readFileSync(file, "utf8"));
    console.log(`shadow: applied ${dir}`);
  }
}

const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
await server.start();

const out = path.join(migrationsDir, name);
fs.mkdirSync(out, { recursive: true });
const sqlPath = path.join(out, "migration.sql");

const code = await new Promise((resolve) => {
  const child = spawn(
    `npx prisma migrate diff --from-url "${url}" --to-schema-datamodel prisma/schema.prisma --script > "${sqlPath}"`,
    {
      shell: true,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url },
    },
  );
  child.on("exit", (c) => resolve(c ?? 1));
});

await server.stop();
await db.close();

if (code !== 0) {
  console.error("migrate diff failed");
  process.exit(1);
}

const sql = fs.readFileSync(sqlPath, "utf8").trim();
if (!sql) {
  console.error("no changes detected - removing empty migration folder");
  fs.rmSync(out, { recursive: true, force: true });
  process.exit(1);
}
console.log(`\nwrote ${path.relative(process.cwd(), sqlPath)}:\n`);
console.log(sql);
