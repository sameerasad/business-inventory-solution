// Boots PGlite + the built Next server, then fetches every page and asserts it
// renders with real data in it.
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { freePortFrom } from "./free-port.mjs";

const PG_PORT = await freePortFrom(54332, "database port");
const APP_PORT = await freePortFrom(3111, "app port");
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

// Never build into .next: the dev server shares it, and mixing dev and
// production artifacts leaves the dev server serving a page with no CSS.
const DIST = ".next-verify";
/**
 * The app is behind a password now, so the harness has to be on the inside of
 * it - every page would otherwise answer with a redirect to /login and the
 * whole suite would pass its status check while testing nothing.
 *
 * It sets the credentials for the server it starts and then mints its own
 * cookie with the same HMAC the app uses. Going through the login form would
 * test the form; this tests the pages, which is what this suite is for. The
 * form is covered where it belongs, in the auth checks below.
 */
const AUTH_SECRET = "smoke-suite-secret-not-a-real-one";
const AUTH_PASSWORD = "smoke-password";

const env = {
  ...process.env,
  DATABASE_URL: url,
  DATABASE_URL_UNPOOLED: url,
  DEFAULT_ACTOR: "smoke",
  NEXT_DIST_DIR: DIST,
  AUTH_SECRET,
  AUTH_PASSWORD,
};

/**
 * A session cookie for a given user id.
 *
 * The body is "expires:userId" and the whole of it is signed, which is what
 * stops a booker editing their own id into an admin's. Id 0 is the break-glass
 * owner: it belongs to no row, so it works before any account exists.
 */
function sessionCookie(userId = 0) {
  const body = `${Date.now() + 86400_000}:${userId}`;
  const mac = createHmac("sha256", AUTH_SECRET).update(body).digest("hex");
  return `ibt_session=${body}.${mac}`;
}
const COOKIE = sessionCookie();

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

console.log(`\nbuilding into ${DIST}/ (leaving .next alone for next dev)...`);
if ((await run("npx next build")) !== 0) process.exit(1);

if ((await run("npx tsx prisma/seed.ts")) !== 0) process.exit(1);
if (
  (await run("npx tsx --tsconfig .verify/tsconfig.verify.json .verify/sample-data.ts")) !== 0
)
  process.exit(1);

/**
 * Three booker accounts, inserted straight into the database.
 *
 * One is linked to the booker the sample data attributed its bookings to; one
 * to a booker with no bookings at all. The pair is the point: the first proves
 * a booker still sees their own work, the second proves the scoping is a real
 * filter rather than a no-op that happens to look right because there is only
 * one booker in the database.
 *
 * The third is linked to no booker, which is the dangerous case - a null id
 * read as "no filter" would hand them the whole business.
 */
await db.exec(`
  INSERT INTO bookers (name, is_active, is_deleted, created_at, updated_at)
  VALUES ('Smoke Other', true, false, now(), now())
  ON CONFLICT DO NOTHING;
`);
const bookerRows = await db.query(
  "SELECT id, name FROM bookers WHERE name IN ('Sample Booker', 'Smoke Other')",
);
const bookerId = (name) => bookerRows.rows.find((r) => r.name === name)?.id ?? null;
await db.exec(`
  INSERT INTO users (username, name, password_hash, role, booker_id, is_active, created_at, updated_at)
  VALUES
    ('smoke_working', 'Smoke Working', 'x', 'booker', ${bookerId("Sample Booker")}, true, now(), now()),
    ('smoke_other',   'Smoke Other',   'x', 'booker', ${bookerId("Smoke Other")}, true, now(), now()),
    ('smoke_nobody',  'Smoke Nobody',  'x', 'booker', NULL, true, now(), now()),
    ('smoke_boss',    'Smoke Boss',    'x', 'admin',  NULL, true, now(), now())
  ON CONFLICT (username) DO NOTHING;
`);
const userRows = await db.query("SELECT id, username FROM users WHERE username LIKE 'smoke\\_%'");
const userId = (u) => userRows.rows.find((r) => r.username === u)?.id;
const bookingRows = await db.query(
  "SELECT id FROM bookings WHERE booker_id = $1 AND is_deleted = false ORDER BY id LIMIT 1",
  [bookerId("Sample Booker")],
);
const SAMPLE_BOOKING = bookingRows.rows[0]?.id;

const WORKING = sessionCookie(userId("smoke_working"));
const OTHER = sessionCookie(userId("smoke_other"));
const NOBODY = sessionCookie(userId("smoke_nobody"));
const BOSS = sessionCookie(userId("smoke_boss"));

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
    const res = await fetch(`http://127.0.0.1:${APP_PORT}/dashboard`, {
      redirect: "manual",
      headers: { cookie: COOKIE },
    });
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
// Every page must be reachable from the nav, on every page. A link silently
// missing from the nav is indistinguishable from the page not existing - which
// is exactly what an overflowing single-row nav used to cause.
const NAV_LINKS = [
  "/dashboard",
  "/bookings/new",
  "/sales/new",
  "/batches/new",
  "/bookings",
  "/receivables",
  "/sales",
  "/batches",
  "/products",
  "/bookers",
  "/users",
  "/voice",
  "/areas",
].map((href) => `href="${href}"`);

const pages = [
  ["/", ["Dashboard"]],
  ["/dashboard", NAV_LINKS],
  // The header brand is the business name from BUSINESS_NAME, not a hardcoded
  // one, and it must not wrap: the subtitle is the tell that the two-tier
  // header rendered rather than the old single squeezed row.
  ["/dashboard", ["Inventory &amp; profit", 'href="/dashboard"']],
  ["/receivables", ["Receivables", "Outstanding", "Collected", "Invoiced"]],
  ["/areas", NAV_LINKS],
  [
    "/bookings",
    [
      "Bookings",
      "Invoice",
      "Booked value",
      "Booker",
      ">All bookers</span>",
      "Edit",
    ],
  ],
  [
    "/voice",
    [
      "Voice",
      "What you can say",
      // The page must render server-side even though the mic is client-only.
      "Open a page",
      "Record a payment",
      "Receive stock",
      "Cash sale at the counter",
      "Add a shop",
      // The hands-free toggle and its safety wording must both be on the page.
      "Hands-free",
      "all cancel",
      // The typed fallback must render even where speech is unsupported.
      "Or type it",
      // The safety promise is part of the page, not just the code.
      "waits for a yes",
    ],
  ],
  [
    "/bookers",
    [
      "Bookers",
      "Booked value",
      "Collected",
      "Territory",
      "Manage bookers",
      "Add booker",
      "Sample Booker",
      // Two of the areas are assigned to the sample booker; the rest are not,
      // and the page must call that out rather than leave a silent gap.
      "Nobody is assigned to",
      "Territory",
    ],
  ],
  [
    "/bookings/new",
    [
      "New booking",
      "Customer &amp; date",
      "Customer name",
      "Add line",
      "Order total",
      // The booker picker must offer the seeded booker, not an empty state.
      "Sample Booker",
    ],
  ],
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
      "Received",
      "Delivered",
      `>${YEAR}</span>`,
      ">All categories</span>",
      ">All areas</span>",
      ">All bookers</span>",
      "Revenue &amp; profit by booker",
      "Bottle",
      "Tetra Pack",
      "Downtown",
    ],
  ],
  // A year that is not in the dropdown (no data, not the current year) falls back
  // to a selectable year rather than rendering a mismatched Select value.
  ["/dashboard?year=2020", ["Dashboard", `>${YEAR}</span>`]],
  ["/dashboard?from=2020-01-01&to=2099-12-31", ["Dashboard", "Selected range"]],
  ["/dashboard?from=2020-01-01", ["Dashboard", "Selected range"]],
  ["/dashboard?to=2099-12-31", ["Dashboard", "Selected range"]],
  // Backwards, which must narrow nothing rather than 500 the page.
  ["/dashboard?from=2099-01-01&to=2020-12-31", ["Dashboard", "This Year"]],
  ["/dashboard?from=not-a-date", ["Dashboard", "This Year"]],
  ["/dashboard?year=notanumber", ["Dashboard", `>${YEAR}</span>`]],
  ["/dashboard?category=999999", ["Dashboard", ">All categories</span>"]],
  ["/dashboard?booker=999999", ["Dashboard", ">All bookers</span>"]],
  ["/dashboard?booker=notanumber", ["Dashboard", ">All bookers</span>"]],
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
  [
    "/products",
    [
      "Products",
      "MNG-BTL-250",
      "Current stock",
      "CHO-BAR-10",
      "Stock value at cost",
      // Categories are managed here, and every row is editable.
      "Categories",
      "New category",
      "Juice &amp; Beverage",
      "Rename",
      "Edit",
    ],
  ],
  [
    "/areas",
    [
      "Areas &amp; Shops",
      "Downtown",
      "Central Mart",
      "New area",
      // Coverage is shown per area, and an unassigned one links to the fix.
      "No booker assigned",
      // The Voice name field is deliberately NOT asserted here: it lives inside
      // the rename form, which only exists after a click, so the server HTML
      // cannot contain it. The parser tests cover what it does.
      'href="/bookers"',
    ],
  ],
  ["/batches", ["Batches", "Remaining", "Unit cost", "MNG-BTL-250", ">All products</span>", "Edit"]],
  ["/batches?status=active", ["Batches", ">Active (stock left)</span>"]],
  [
    "/sales",
    [
      "Sales",
      "Profit",
      "Margin",
      "Direct sale",
      ">All areas</span>",
      "Source",
      "Counter sale",
      "Edit",
    ],
  ],
  ["/sales?from=2020-01-01&to=2020-12-31", ["No sales match these filters"]],
  ["/sales?from=2030-01-01&to=2020-12-31", ["date filter was ignored"]],

  // Every filter, actually used.
  //
  // These exist because a filter is a piece of SQL that only runs when someone
  // selects it. A search clause reaching for a table the totals query never
  // joined, or a status predicate naming an alias that only exists in the list
  // query, is invisible until the moment a person types in the box - and then
  // it is a 500 on a page that worked a second earlier. Fetching each page
  // WITH its filters applied is the only thing that exercises those paths.
  ["/bookings?q=INV", ["Bookings"]],
  ["/bookings?q=zzzz-nothing-matches", ["Bookings"]],
  ["/bookings?status=unpaid", ["Bookings", ">Unpaid</span>"]],
  ["/bookings?status=paid", ["Bookings"]],
  ["/bookings?status=partial", ["Bookings"]],
  ["/sales?q=mango", ["Sales"]],
  ["/sales?q=zzzz-nothing-matches", ["No sales match these filters"]],
  ["/sales?kind=counter", ["Sales", ">Counter (cash)</span>"]],
  ["/sales?kind=booked", ["Sales", ">On an invoice</span>"]],
  ["/batches?q=mango", ["Batches"]],
  ["/batches?from=2000-01-01&to=2099-12-31", ["Batches"]],
  ["/receivables?q=a", ["Receivables"]],
  ["/receivables?age=60%2B", ["Receivables", ">60+ days</span>"]],
  ["/receivables?age=0-7", ["Receivables"]],
  ["/products?q=mango", ["Products"]],
  ["/products?stock=out", ["Products", ">Out of stock</span>"]],
  ["/products?stock=in", ["Products"]],
  ["/bookers?q=a", ["Bookers"]],
  ["/areas?q=a", ["Areas"]],
  ["/areas?q=zzzz-nothing-matches", ["Nothing matches"]],
];

for (const [pathname, markers] of pages) {
  try {
    const res = await fetch(`http://127.0.0.1:${APP_PORT}${pathname}`, {
      headers: { cookie: COOKIE },
    });
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
    // Voice has to be reachable from EVERY page, which is a claim about every
    // page rather than about any one of them - so it is checked in the loop
    // rather than listed per page, and a page added to this suite later gets
    // the check for free. Server-rendered, so it is there before hydration.
    check(
      `${pathname} has the voice button`,
      html.includes('aria-label="Open voice commands"'),
      pathname,
    );
  } catch (err) {
    check(`${pathname} fetched`, false, err.message);
  }
}

/* ------------------------------------------------------------------- the gate */
/**
 * The app was open to anyone with the URL until now, including the button that
 * marks every invoice in the business as paid. These check the gate itself
 * rather than what is behind it.
 */
const bare = (pathname, init) => fetch(`http://127.0.0.1:${APP_PORT}${pathname}`, {
  redirect: "manual",
  ...init,
});

{
  const res = await bare("/dashboard");
  check("a page with no cookie redirects", res.status === 307 || res.status === 302, res.status);
  check(
    "and it redirects to the login page",
    (res.headers.get("location") ?? "").includes("/login"),
    res.headers.get("location"),
  );
  check(
    "carrying where they were going",
    (res.headers.get("location") ?? "").includes("next="),
    res.headers.get("location"),
  );
}

{
  const res = await bare("/api/invoices/1");
  check("an API call with no cookie gets 401, not a login page", res.status === 401, res.status);
}

{
  // Signed with the wrong key, and with a timestamp far in the future - so it
  // fails on the signature rather than on having expired.
  const expires = String(Date.now() + 86400_000);
  const mac = createHmac("sha256", "not-the-real-secret").update(expires).digest("hex");
  const res = await bare("/dashboard", { headers: { cookie: `ibt_session=${expires}.${mac}` } });
  check("a forged cookie is refused", res.status !== 200, res.status);
}

{
  // Correctly signed, but the expiry inside it has passed. The expiry is part
  // of what is signed, so this is the only way to have a valid signature on a
  // dead session.
  const body = `${Date.now() - 1000}:0`;
  const mac = createHmac("sha256", AUTH_SECRET).update(body).digest("hex");
  const res = await bare("/dashboard", { headers: { cookie: `ibt_session=${body}.${mac}` } });
  check("an expired cookie is refused", res.status !== 200, res.status);
}

{
  const res = await bare("/login");
  check("the login page itself is reachable", res.status === 200, res.status);
}

/**
 * The one thing that must stay open.
 *
 * Customers open this from a WhatsApp message and have no account and never
 * will. A wrong token must come back as not-found rather than as a redirect to
 * a login page - a redirect here would mean every invoice this business has
 * ever sent stopped being readable, and nothing would say so.
 */
{
  const res = await bare("/api/invoices/share/definitely-not-a-real-token");
  check(
    "the customer invoice link is not behind the gate",
    res.status !== 307 && res.status !== 302,
    res.status,
  );
  check("and an unknown token is simply not found", res.status === 404, res.status);
}

/* ------------------------------------------------------------------ roles */
/**
 * What a booker can and cannot reach.
 *
 * Checked over HTTP against the real server rather than by calling the guard
 * helpers, because the question is not "does the helper return false" - it is
 * "can this person get the page". Those are the same thing right up until
 * somebody adds a route and forgets the guard.
 */
console.log("\n=== roles ===");

const get = (pathname, cookie) =>
  fetch(`http://127.0.0.1:${APP_PORT}${pathname}`, { redirect: "manual", headers: { cookie } });

// Everything that shows what stock cost, what it earned, or changes the shape
// of the business.
for (const pathname of [
  "/dashboard",
  "/sales",
  "/sales/new",
  "/batches",
  "/batches/new",
  "/products",
  "/bookers",
  "/users",
]) {
  const res = await get(pathname, WORKING);
  const to = res.headers.get("location") ?? "";
  check(
    `a booker is turned away from ${pathname}`,
    (res.status === 307 || res.status === 302) && to.includes("/my"),
    `${res.status} -> ${to}`,
  );
}

// ...and the same pages still open for the owner.
for (const pathname of ["/dashboard", "/sales", "/batches", "/products", "/bookers", "/users"]) {
  const res = await get(pathname, COOKIE);
  check(`an admin still reaches ${pathname}`, res.status === 200, res.status);
}

/**
 * The other half of every check below it.
 *
 * "The booker's page does not contain X" passes just as happily when nothing
 * renders X at all - a renamed class, a dialog that only mounts on click - and
 * then it is a test of a typo rather than of the gate. These assert the same
 * markers ARE on the admin's copy of the same page, so the absence below means
 * something.
 */
{
  const res = await get("/bookings", COOKIE);
  const html = await res.text();
  check("the admin's bookings page does carry a profit column", html.includes(">Profit</th>"));
  check("and a profit total", html.includes("Profit (filtered)"));
  check("and a cancel control", html.includes("Cancel booking"));
  check("and invoices to find", html.includes("INV-"));
}

{
  const res = await get("/bookings", WORKING);
  const html = await res.text();
  check("a booker reaches the bookings page", res.status === 200, res.status);
  // The margin on every line is on this page for an admin. It is the one
  // figure a booker negotiating a price must not be able to read.
  check("and it carries no profit column", !html.includes(">Profit</th>"), "profit header present");
  check("and no profit total", !html.includes("Profit (filtered)"), "profit tile present");
  // A booker cannot change or cancel an order after the fact.
  check("and no cancel button", !html.includes("Cancel booking"), "cancel present");
  // Their own orders ARE there: scoping that shows nothing is not scoping.
  check("but their own invoices are", html.includes("INV-"), "no invoices at all");
}

{
  const res = await get("/bookings", OTHER);
  const html = await res.text();
  check("a booker with no orders reaches the page", res.status === 200, res.status);
  check(
    "and sees none of the other booker's invoices",
    !html.includes("INV-"),
    "another booker's invoices leaked",
  );
}

{
  const res = await get("/bookings", NOBODY);
  const html = await res.text();
  // The one that matters: a null booker id read as "no filter" would show the
  // whole business to an account linked to nobody.
  check(
    "an account linked to no booker sees nothing, not everything",
    res.status === 200 && !html.includes("INV-"),
    String(res.status),
  );
}

{
  // A booker needs to add the shop they just walked into. They must not be
  // able to rename one, which would silently rename it on every invoice
  // already sent, or delete an area.
  const mine = await get("/areas", WORKING);
  const theirs = await mine.text();
  const owner = await get("/areas", COOKIE);
  const all = await owner.text();

  check("the admin's areas page offers rename", all.includes(">Rename<"));
  check("and delete", all.includes("Delete area"));
  check("a booker's does not offer rename", !theirs.includes(">Rename<"), "rename offered");
  check("nor delete", !theirs.includes("Delete area"), "delete offered");
  // The half they do need.
  check("but still offers add shop", theirs.includes("Add shop"), "cannot add a shop");
  check("and add area", theirs.includes("Add area"), "cannot add an area");
}

{
  // The invoice PDF takes a booking id straight off the URL. Signed in is not
  // the same as entitled, and ids are small integers.
  check("there is a sample booking to probe with", SAMPLE_BOOKING != null, SAMPLE_BOOKING);

  const own = await get(`/api/invoices/${SAMPLE_BOOKING}`, WORKING);
  check("a booker can download their own invoice", own.status === 200, own.status);

  const other = await get(`/api/invoices/${SAMPLE_BOOKING}`, OTHER);
  check(
    "but not another booker's",
    other.status === 404,
    `got ${other.status}, wanted 404`,
  );

  const owner = await get(`/api/invoices/${SAMPLE_BOOKING}`, COOKIE);
  check("and the owner can download any of them", owner.status === 200, owner.status);
}

{
  /**
   * The header has to say whose session this is.
   *
   * Without it there was no way to tell a booker's session from the owner's
   * except by noticing which tabs were missing - and when the emergency
   * password quietly outranked a typed username, that was the only symptom
   * there was.
   */
  const asBooker = await (await get("/bookings", WORKING)).text();
  check("a booker's header says Booker", asBooker.includes(">Booker<"), "no role chip");
  check("and names them", asBooker.includes("Smoke Working"), "no name");
  check("and does not say Admin", !asBooker.includes(">Admin<"));

  const asAdmin = await (await get("/dashboard", BOSS)).text();
  check("an admin's header says Admin", asAdmin.includes(">Admin<"), "no role chip");
  check("and names them", asAdmin.includes("Smoke Boss"), "no name");

  // The break-glass session is not an account, and must not be dressed as one.
  const asOwner = await (await get("/dashboard", COOKIE)).text();
  check(
    "the emergency session says Emergency, not Admin",
    asOwner.includes(">Emergency<") && !asOwner.includes(">Admin<"),
    "break-glass looks like an ordinary admin",
  );
}

{
  const res = await get("/", WORKING);
  check(
    "the front door sends a booker to their own page",
    (res.headers.get("location") ?? "").includes("/my"),
    res.headers.get("location"),
  );
}

{
  const res = await get("/my", WORKING);
  const html = await res.text();
  check("a booker's own page renders", res.status === 200, res.status);
  check("and it shows a target", html.includes("Booked value"), "no target panel");
  check("and draws no dashboard link", !html.includes('href="/dashboard"'), "dashboard link drawn");
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
