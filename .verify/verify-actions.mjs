/**
 * Server actions, driven through a real browser, by somebody really signed in.
 *
 * This is the gap every other suite leaves. verify:pages fetches HTML and
 * never submits anything. The action suites (verify:bookings, verify:payments,
 * and the rest) call the actions straight from a script, where there is no
 * request and therefore no cookie - so currentUser() returns null and every
 * branch that depends on who is asking is never taken.
 *
 * That gap shipped a broken Receive Stock page. The action read the signed-in
 * user in the middle of its transaction; with no cookie that read returns
 * early and costs nothing, so the whole repository stayed green while the
 * page failed for every real person who tried it.
 *
 * So this signs in, clicks the buttons, and then looks in the database.
 *
 * It runs `next dev` rather than a production build on purpose. db.ts caches
 * the Prisma client on globalThis only outside production, and PGlite's socket
 * server accepts one connection at a time - so a production build here opens a
 * second client and fails for reasons that have nothing to do with the app.
 * Real Postgres would not care. Dev keeps one client and one connection, and
 * the server actions under test are the same code either way.
 */
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { chromium } from "playwright";
import { freePortFrom } from "./free-port.mjs";

const PG_PORT = await freePortFrom(54362, "database port");
const APP_PORT = await freePortFrom(3141, "app port");
const url =
  `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/postgres` +
  `?schema=public&connection_limit=1&statement_cache_size=0&pool_timeout=60`;

const db = await PGlite.create();
for (const dir of fs
  .readdirSync("prisma/migrations", { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()) {
  await db.exec(fs.readFileSync(path.join("prisma/migrations", dir, "migration.sql"), "utf8"));
}
const server = new PGLiteSocketServer({ db, port: PG_PORT, host: "127.0.0.1" });
await server.start();

const AUTH_SECRET = "verify-actions-secret-not-a-real-one";
const env = {
  ...process.env,
  DATABASE_URL: url,
  DATABASE_URL_UNPOOLED: url,
  AUTH_SECRET,
  // No break-glass password: everybody here signs in as a real account, which
  // is the point - the emergency session skips the users table entirely.
  AUTH_PASSWORD: "",
};

let failures = 0;
/**
 * Detail is truncated hard.
 *
 * One of the things this reports on is the dev server's log, and a single
 * line of that can be an entire minified bundle. A failure that buries itself
 * under ten thousand characters of someone else's JavaScript is a failure
 * nobody reads.
 */
const brief = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s == null ? "" : s.length > 300 ? `${s.slice(0, 300)}...` : s;
};
const check = (label, condition, detail) => {
  if (condition) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}`, detail === undefined ? "" : brief(detail));
  }
};

function run(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, stdio: "inherit", env });
    child.on("exit", (c) => resolve(c ?? 1));
  });
}
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

if ((await run("npx tsx prisma/seed.ts")) !== 0) process.exit(1);

/* ------------------------------------------------------------ the people */

const downtown = (await db.query("SELECT id FROM areas WHERE name = 'Downtown'")).rows[0];
const south = (await db.query("SELECT id FROM areas WHERE name = 'South Zone'")).rows[0];

await db.exec(`
  INSERT INTO bookers (name, is_active, is_deleted, created_at, updated_at)
  VALUES ('Rafi The Booker', true, false, now(), now());
`);
const booker = (await db.query("SELECT id FROM bookers WHERE name = 'Rafi The Booker'")).rows[0];
await db.exec(`INSERT INTO booker_areas (booker_id, area_id) VALUES (${booker.id}, ${downtown.id});`);

await db.exec(`
  INSERT INTO users (username, name, password_hash, role, booker_id, is_active, created_at, updated_at)
  VALUES
    ('boss', 'Nadia The Owner', 'x', 'admin',  NULL, true, now(), now()),
    ('rafi', 'Rafi The Booker', 'x', 'booker', ${booker.id}, true, now(), now());
`);
const users = await db.query("SELECT id, username FROM users");
const idOf = (u) => users.rows.find((r) => r.username === u).id;

/** A cookie the app will accept, signed the way newSession signs one. */
function cookieFor(userId) {
  const body = `${Date.now() + 86400_000}:${userId}`;
  return `${body}.${createHmac("sha256", AUTH_SECRET).update(body).digest("hex")}`;
}

/* -------------------------------------------------------------- the app */

console.log("\nstarting next dev...");
const app = spawn(`npx next dev --port ${APP_PORT}`, {
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
  env,
});
let appLog = "";
app.stdout.on("data", (d) => (appLog += d.toString()));
app.stderr.on("data", (d) => (appLog += d.toString()));

let up = false;
for (let i = 0; i < 90; i += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const res = await fetch(`http://127.0.0.1:${APP_PORT}/login`, { redirect: "manual" });
    if (res.status < 500) {
      up = true;
      break;
    }
  } catch {}
}
if (!up) {
  console.error("server never came up:\n", appLog.slice(-3000));
  killTree(app);
  await server.stop();
  await db.close();
  process.exit(1);
}

const browser = await chromium.launch();

/** A browser already signed in as one of the accounts above. */
async function sessionFor(username) {
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: "ibt_session",
      value: cookieFor(idOf(username)),
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
    },
  ]);
  const page = await context.newPage();
  return { context, page };
}

/** Open one of the app's Radix selects and take the first real option. */
async function pickFirst(page, id) {
  await page.click(`#${id}`);
  const option = page.locator('[role="option"]').first();
  await option.waitFor({ state: "visible", timeout: 10_000 });
  const label = (await option.textContent())?.trim();
  await option.click();
  await page.waitForTimeout(150);
  return label;
}

const rows = async (sql) => (await db.query(sql)).rows;

/* ------------------------------------------------- receiving stock, as the owner */
/**
 * The exact page that broke, with the exact question it could not answer:
 * does this work when somebody is actually signed in.
 */
console.log("\n=== receive stock, signed in as the owner ===");
{
  const { context, page } = await sessionFor("boss");
  await page.goto(`http://127.0.0.1:${APP_PORT}/batches/new`, { waitUntil: "networkidle" });

  for (const id of ["pick-category", "pick-name", "pick-packaging", "pick-variant"]) {
    await pickFirst(page, id);
  }
  const productId = await page.inputValue('input[name="productId"]');
  check("the product cascade resolves to a product", /^\d+$/.test(productId), productId);

  await page.fill("#quantity", "40");
  await page.fill("#unitCost", "280");
  await page.fill("#receivedDate", "2026-10-23");

  // By name, not by `button[type=submit]`: the first submit button on every
  // page is the sign-out form in the header, and clicking that signs you out
  // and explains nothing.
  await page.getByRole("button", { name: "Receive stock" }).click();
  await page.waitForTimeout(3000);

  const saved = await rows("SELECT id, quantity, unit_cost, created_by FROM batches ORDER BY id DESC LIMIT 1");
  check("the batch is in the database", saved.length === 1, saved);
  check("with the quantity that was typed", saved[0]?.quantity === 40, saved[0]);
  check("and the cost", String(saved[0]?.unit_cost) === "280.00", saved[0]?.unit_cost);

  /**
   * The whole point of giving actions a session. This read "owner" for every
   * action in the app until the audit actor was threaded through, and nothing
   * in the repository could tell.
   */
  check(
    "created_by names the person who did it",
    saved[0]?.created_by === "Nadia The Owner",
    saved[0]?.created_by,
  );
  const audit = await rows(
    "SELECT actor, action FROM audit_logs WHERE entity_type = 'batch' ORDER BY id DESC LIMIT 1",
  );
  check("and so does the audit row", audit[0]?.actor === "Nadia The Owner", audit[0]);
  check("which records what happened", audit[0]?.action === "batch.created", audit[0]);

  await context.close();
}

/* ------------------------------------------------------ adding a shop, as a booker */
/**
 * A booker's own write, through their own session. Covers three things at
 * once: that a booker may add a shop at all, that the audit names them rather
 * than the owner, and that the only area they are offered is their own.
 */
console.log("\n=== add a shop, signed in as a booker ===");
{
  const { context, page } = await sessionFor("rafi");
  await page.goto(`http://127.0.0.1:${APP_PORT}/areas`, { waitUntil: "networkidle" });

  const html = await page.content();
  check("the booker sees their own area", html.includes("Downtown"), "Downtown missing");
  check(
    "and not an area they were never assigned",
    !html.includes("South Zone"),
    "South Zone leaked",
  );

  const nameBox = page.getByPlaceholder("Shop name").first();
  await nameBox.waitFor({ state: "visible", timeout: 10_000 });
  await nameBox.fill("Rafi Test Store");
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await page.waitForTimeout(3000);

  const shop = await rows(
    "SELECT id, name, area_id FROM shops WHERE name = 'Rafi Test Store'",
  );
  check("the shop was created", shop.length === 1, shop);
  check("in the booker's own area", shop[0]?.area_id === downtown.id, shop[0]);

  const audit = await rows(
    `SELECT actor, action FROM audit_logs WHERE entity_type = 'shop' AND entity_id = ${shop[0]?.id ?? 0}`,
  );
  check("and the audit names the booker, not the owner", audit[0]?.actor === "Rafi The Booker", audit[0]);

  await context.close();
}

/* ------------------------------------------------------------------ cleanup */

const serverErrors = appLog
  .split("\n")
  .filter((l) => /prisma:error|Unhandled|TypeError|PrismaClientInitializationError/.test(l));
check("no server-side errors logged", serverErrors.length === 0, serverErrors.slice(0, 3));

await browser.close();
killTree(app);
await new Promise((r) => setTimeout(r, 500));
await server.stop();
await db.close();

console.log(failures === 0 ? "\nACTIONS OK" : `\n${failures} ACTION FAILURES`);
process.exit(failures === 0 ? 0 : 1);
