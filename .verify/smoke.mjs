// Boots PGlite + the built Next server, then fetches every page and asserts it
// renders with real data in it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const PG_PORT = 54332;
const APP_PORT = 3111;
const url = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/postgres?schema=public&connection_limit=1&statement_cache_size=0&pool_timeout=60`;

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

const env = { ...process.env, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url, DEFAULT_ACTOR: "smoke" };

function run(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, stdio: "inherit", env });
    child.on("exit", (c) => resolve(c ?? 1));
  });
}

/**
 * spawn(..., { shell: true }) puts a cmd.exe / sh wrapper between us and the
 * server, so killing the returned pid orphans the actual Next process - which
 * then keeps holding the port and the Prisma query-engine DLL. Kill the tree.
 */
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

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}`, detail ?? "");
  }
};

if ((await run("npx tsx prisma/seed.ts")) !== 0) process.exit(1);
if (
  (await run("npx tsx --tsconfig .verify/tsconfig.verify.json .verify/sample-data.ts")) !== 0
)
  process.exit(1);

console.log("\nstarting next server...");
const app = spawn(`npx next start --port ${APP_PORT}`, {
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
  env,
});
let appLog = "";
app.stdout.on("data", (d) => (appLog += d.toString()));
app.stderr.on("data", (d) => (appLog += d.toString()));

// Wait for the port to answer.
let up = false;
for (let i = 0; i < 60; i += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const res = await fetch(`http://127.0.0.1:${APP_PORT}/dashboard`, { redirect: "manual" });
    if (res.status < 500) {
      up = true;
      break;
    }
  } catch {}
}
if (!up) {
  console.error("server never came up:\n", appLog);
  killTree(app);
  await server.stop();
  await db.close();
  process.exit(1);
}

console.log("\n=== page renders ===");
const YEAR = new Date().getFullYear();
// Markers include the *rendered value* of pre-selected dropdowns: Radix leaves a
// pre-selected trigger blank unless the label is passed explicitly, so these
// assertions are what stop that regressing.
const pages = [
  ["/", ["Dashboard"]],
  [
    "/dashboard",
    [
      "Monthly revenue &amp; profit",
      "Revenue by packaging type",
      "Revenue by volume size",
      "Revenue by flavor",
      "Category split",
      "Revenue &amp; profit by area",
      "Top shops",
      "This Month",
      "This Year",
      `>${YEAR}</span>`,
      ">All categories</span>",
      ">All areas</span>",
      "Bottle",
      "Tetra Pack",
      "Downtown",
    ],
  ],
  // A year that is not in the dropdown (no data, not the current year) falls back
  // to a selectable year rather than rendering a mismatched Select value.
  ["/dashboard?year=2020", ["Dashboard", `>${YEAR}</span>`]],
  ["/dashboard?year=notanumber", ["Dashboard", `>${YEAR}</span>`]],
  ["/dashboard?category=999999", ["Dashboard", ">All categories</span>"]],
  ["/dashboard?period=month", ["Revenue &amp; profit by area"]],
  ["/batches/new", ["Receive stock", "Unit cost", "Received date", "SKU", "Select a category"]],
  [
    "/sales/new",
    [
      "Record a sale",
      "Batch to sell from",
      ">Direct Sale / No Shop</span>",
      "Sale price",
      "Select an area",
    ],
  ],
  ["/products", ["Products", "MNG-BTL-250", "Current stock", "CHO-BAR-10", "Stock value at cost"]],
  ["/areas", ["Areas &amp; Shops", "Downtown", "Central Mart", "New area"]],
  ["/batches", ["Batches", "Remaining", "Unit cost", "MNG-BTL-250", ">All products</span>"]],
  ["/batches?status=active", ["Batches", ">Active (stock left)</span>"]],
  ["/sales", ["Sales", "Profit", "Margin", "Direct sale", ">All areas</span>"]],
  ["/sales?from=2020-01-01&to=2020-12-31", ["No sales match these filters"]],
  ["/sales?from=2030-01-01&to=2020-12-31", ["date filter was ignored"]],
];

for (const [pathname, markers] of pages) {
  try {
    const res = await fetch(`http://127.0.0.1:${APP_PORT}${pathname}`);
    const html = await res.text();
    check(`${pathname} -> ${res.status}`, res.status === 200, res.status);
    for (const marker of markers) {
      const found = html.includes(marker);
      check(`${pathname} contains "${marker}"`, found);
      if (!found && marker.startsWith(">")) {
        const needle = marker.slice(1, marker.indexOf("<"));
        const at = html.indexOf(needle);
        console.error("      needle:", JSON.stringify(needle), "found at", at,
          at >= 0 ? JSON.stringify(html.slice(Math.max(0, at - 90), at + 40)) : "");
      }
    }
    check(`${pathname} has no error digest`, !html.includes("Application error"), pathname);
  } catch (err) {
    check(`${pathname} fetched`, false, err.message);
  }
}

if (/Error|error:/i.test(appLog) && !/Compiled|ready/i.test(appLog)) {
  console.log("\nserver log:\n", appLog.slice(-2000));
}
const serverErrors = appLog.split("\n").filter((l) => /prisma:error|Unhandled|TypeError/.test(l));
check("no server-side errors logged", serverErrors.length === 0, serverErrors.slice(0, 5));

killTree(app);
await new Promise((r) => setTimeout(r, 500));
await server.stop();
await db.close();

console.log(failures === 0 ? "\nSMOKE OK" : `\n${failures} SMOKE FAILURES`);
process.exit(failures === 0 ? 0 : 1);
