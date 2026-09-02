/**
 * Run the whole app with no PostgreSQL installed.
 *
 *   npm run dev:sandbox     ->  prints the URL it picked (3000 if free)
 *
 * Boots PGlite (real PostgreSQL, compiled to WebAssembly) on a local socket,
 * applies the migrations, seeds the catalog, then starts `next dev` pointed at
 * it. Data persists in .verify/pgdata between runs, so you can add batches and
 * sales, stop the server, and come back to them.
 *
 * This is a convenience for trying the app out. For real use, point DATABASE_URL
 * at a normal PostgreSQL server - see the README.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { freePortFrom } from "./free-port.mjs";

/**
 * Both ports are chosen at runtime rather than fixed, so the sandbox can run
 * alongside a normal `npm run dev` - which is the whole point of having a
 * throwaway database.
 */
async function pick(start, label) {
  const port = await freePortFrom(start, label);
  if (port !== start) console.log(`  ${label} ${start} is busy - using ${port} instead`);
  return port;
}

const DATA_DIR = path.join(process.cwd(), ".verify", "pgdata");
const PG_PORT = await pick(Number(process.env.SANDBOX_PG_PORT ?? 54329), "database port");
const APP_PORT = await pick(Number(process.env.PORT ?? 3000), "app port");

const url =
  `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/postgres` +
  // statement_cache_size=0: PGlite shares one session across reconnects, so a
  // cached prepared statement name would collide after Prisma reconnects.
  `?schema=public&statement_cache_size=0&connection_limit=5&pool_timeout=30`;

const fresh = !fs.existsSync(DATA_DIR);
console.log(
  fresh
    ? `\nCreating a new sandbox database in ${path.relative(process.cwd(), DATA_DIR)}`
    : `\nReusing the sandbox database in ${path.relative(process.cwd(), DATA_DIR)}`,
);

const db = await PGlite.create({ dataDir: DATA_DIR });

const server = new PGLiteSocketServer({
  db,
  port: PG_PORT,
  host: "127.0.0.1",
  // The default is 1, which makes a single dropped connection look like the
  // whole database went away. Next dev opens several; give it room.
  maxConnections: 20,
});
await server.start();
console.log(`Sandbox PostgreSQL listening on 127.0.0.1:${PG_PORT}`);

const env = {
  ...process.env,
  DATABASE_URL: url,
  // schema.prisma references this for CLI migrations; same endpoint here.
  DATABASE_URL_UNPOOLED: url,
  DEFAULT_ACTOR: process.env.DEFAULT_ACTOR ?? "sandbox",
};

function run(cmd, label) {
  return new Promise((resolve, reject) => {
    console.log(`\n> ${label}`);
    const child = spawn(cmd, { shell: true, stdio: "inherit", env });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code})`)),
    );
  });
}

let app;
function shutdown(code) {
  if (app?.pid) {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(app.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-app.pid, "SIGTERM");
      } catch {
        app.kill("SIGTERM");
      }
    }
  }
  // Give the DB a moment to flush to disk so the next run reuses it cleanly.
  setTimeout(async () => {
    try {
      await server.stop();
      await db.close();
    } catch {}
    process.exit(code);
  }, 400);
}

try {
  await run("npx prisma migrate deploy", "prisma migrate deploy");

  const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM products`);
  if (rows[0].n === 0) {
    await run("npx tsx prisma/seed.ts", "seed the catalog");
  } else {
    console.log(`\n> catalog already present (${rows[0].n} products), skipping seed`);
  }

  console.log(`\nStarting the app on http://localhost:${APP_PORT} - Ctrl+C to stop.\n`);
  app = spawn(`npx next dev --port ${APP_PORT}`, {
    shell: true,
    stdio: "inherit",
    env,
    detached: process.platform !== "win32",
  });
  app.on("exit", (code) => shutdown(code ?? 0));
} catch (err) {
  console.error(`\n${err.message}`);
  shutdown(1);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log("\nShutting down the sandbox...");
    shutdown(0);
  });
}
