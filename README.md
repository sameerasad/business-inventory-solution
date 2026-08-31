# Inventory & Profit Tracking

Batch-level inventory and dynamically calculated profit for a juice and chocolate
manufacturing business. Next.js 15 (App Router) · TypeScript · PostgreSQL ·
Prisma · Tailwind · shadcn/ui · Recharts · Zod.

---

## Trying it out with no database installed

If you just want to click through the app, there is a zero-setup path. It boots
PGlite (real PostgreSQL, compiled to WebAssembly) on a local socket, migrates,
seeds, and starts the dev server against it:

```bash
npm install
npm run dev:sandbox        # http://localhost:3000
```

No `.env` and no PostgreSQL needed. Data persists in `.verify/pgdata` between
runs, so batches and sales you enter are still there next time; delete that
folder to start over. Everything works — receiving stock, recording sales, the
dashboard, the charts.

Use this to evaluate. For real use, follow the section below: PGlite is
single-process and not something to run a business on.

---

## Running it locally

### 1. Prerequisites

- Node.js 20 or newer (built and tested on 22)
- A PostgreSQL 14+ database

If you have Docker, this is the fastest way to get one:

```bash
docker run --name inv-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=inventory \
  -p 5432:5432 -d postgres:16
```

### 2. Install and configure

```bash
npm install
cp .env.example .env
```

Then edit `.env`:

```dotenv
# Used by the app at runtime.
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/inventory?schema=public"

# Used only by the Prisma CLI (migrate, studio). Against one plain PostgreSQL
# server, set it to the same value as DATABASE_URL. It matters only on a hosted
# provider where the app connects through a pooler - see the Vercel section.
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/inventory?schema=public"

# Optional. Written into created_by and the audit log until you add real auth.
DEFAULT_ACTOR="owner"
```

### 3. Create the schema and load the catalog

```bash
npm run db:migrate     # applies prisma/migrations (schema + CHECK constraints)
npm run db:seed        # 26 products, 4 areas, 7 shops
```

Then confirm it worked:

```bash
npm run db:check
```

That checks the connection strings for the usual pooled/direct mistakes, connects,
and tells you whether the tables, constraints and catalog are in place — plus what
to run next if something is missing.

`db:seed` is idempotent — re-running it will not duplicate anything, and it
deliberately leaves `default_sale_price` alone so prices you have edited in the
UI survive a reseed.

### 4. Start it

```bash
npm run dev            # http://localhost:3000 -> redirects to /dashboard
```

### Other commands

| Command | What it does |
|---|---|
| `npm run build` | `prisma generate` + production build |
| `npm start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:deploy` | `prisma migrate deploy` (use this on Vercel/CI, not `migrate dev`) |
| `npm run db:reset` | Drop, re-migrate and re-seed. **Destroys all data.** |
| `npm run db:check` | Verify the database is connected, migrated and seeded |
| `npm run db:studio` | Prisma Studio |
| `npm run dev:sandbox` | Run the app against a throwaway PGlite database (no PostgreSQL needed) |
| `npm run verify:all` | Run the whole verification suite (see below) |

---

## Deploying to Vercel

The app is Vercel-ready as-is: `npm run build` runs `prisma generate` first, and
every data page is `dynamic = "force-dynamic"`, so **the build never touches the
database**. You can deploy before the database exists and it will still build.

Vercel runs each request in a serverless function, which changes two things:
you need a **pooled** connection, and migrations are run by you, not by the build.

### 1. Create a database

Any hosted Postgres works — Neon, Supabase, Railway, RDS. Easiest is the Vercel
marketplace (Storage → Postgres), which provisions Neon and injects the
connection variables into the project for you.

Put the database in the **same region** as the functions. A dashboard request
makes ~8 aggregate queries; cross-continent round trips will dominate the page
load.

### 2. Copy the two connection strings

Prisma needs two endpoints, and the schema is already wired for both:

| Variable | Endpoint | Used by |
|---|---|---|
| `DATABASE_URL` | **pooled** | the app at runtime |
| `DATABASE_URL_UNPOOLED` | **direct** | the Prisma CLI (`migrate`, `studio`) only |

In Neon: open the project, click **Connect**, and copy the string. The **pooled**
host has `-pooler` in it; the direct host is the same without it. Take Neon's
string and add Prisma's parameters:

```bash
# Pooled - what the deployed app uses.
# pgbouncer=true is REQUIRED: a transaction pooler cannot keep prepared
# statements, and without it you get intermittent
# 'prepared statement "s0" already exists' errors.
DATABASE_URL="postgresql://USER:PW@ep-xxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require&pgbouncer=true&connection_limit=1&connect_timeout=15"

# Direct - same host without "-pooler". Migrations only.
DATABASE_URL_UNPOOLED="postgresql://USER:PW@ep-xxx.REGION.aws.neon.tech/neondb?sslmode=require"
```

If Neon's copied string includes `channel_binding=require`, drop that parameter —
keep `sslmode=require`.

Set both in Vercel under **Settings → Environment Variables**, plus optionally
`DEFAULT_ACTOR`. If you provisioned Neon through the Vercel marketplace, both
variables are injected under these exact names already — nothing to do.

> The app itself never reads `DATABASE_URL_UNPOOLED` (verified), so a missing
> value cannot break the deployed site. The Prisma **CLI** does error out if it is
> unset, which is why `.env.example` sets it — locally, point it at the same
> database as `DATABASE_URL`.

### 3. Run the migrations, once

Pull the environment down and migrate from your machine. Prisma automatically
uses the direct endpoint for this, because of `directUrl` in the schema:

```bash
npx vercel link          # once, to connect the folder to the project
npx vercel env pull .env.production.local
set -a && . ./.env.production.local && set +a   # PowerShell: see note below
npm run db:deploy
npm run db:seed
```

On PowerShell, instead of `set -a`:

```powershell
Get-Content .env.production.local | ForEach-Object {
  if ($_ -match '^s*([A-Z_]+)="?([^"]*)"?s*$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2]) }
}
npm run db:deploy
npm run db:seed
```

Or just paste the two URLs inline for the one-off:

```bash
DATABASE_URL="<direct-url>" DATABASE_URL_UNPOOLED="<direct-url>" npm run db:deploy
```

Confirm it landed:

```bash
DATABASE_URL="<pooled-url>" DATABASE_URL_UNPOOLED="<direct-url>" npm run db:check
```

Two rules here:

- Use `db:deploy` (`prisma migrate deploy`), **never** `db:migrate`
  (`prisma migrate dev`) — the latter is a development command that wants a
  shadow database and can reset data.
- Do **not** put `prisma migrate deploy` in the Vercel build command. Every
  preview deployment would then migrate whatever database it points at.

### 4. Deploy

```bash
npx vercel        # or push to a Git branch connected to the project
```

Then open `/dashboard`.

### Things to know once it is live

- **There is no authentication.** Anyone with the URL can add and delete stock.
  Put it behind Vercel password protection (a paid feature) or add real auth
  before it holds anything you care about. See the note at the end of this file.
- **Every page is dynamic**, so there is no ISR cache to bust — figures are always
  current, and every page view costs a function invocation plus its queries.
- **The 25 MB of PGlite dev dependencies** (used only by `dev:sandbox` and the
  verification suite) get installed during the Vercel build because Vercel
  installs devDependencies. They are not imported by any app code, so nothing
  ends up in the deployed functions — it costs a few seconds of install time. If
  you would rather not pay it, move `@electric-sql/pglite` and
  `@electric-sql/pglite-socket` out of `package.json` and install them on demand.
- **Node 20+** is required (`engines` in `package.json`); Vercel's current default
  satisfies this.

---

## Verifying it

The business rules have an integration suite that runs against a real Postgres
without you installing one — PGlite (Postgres compiled to WebAssembly) is booted
on a socket and the real Prisma client and real server actions are driven against
it:

```bash
npm run verify:all
```

That runs, in order: `tsc --noEmit`; the data-layer suite (106 checks covering
stock deduction, idempotency, oversell rejection, every dashboard aggregate
against hand-computed totals, soft deletes, listings, CRUD and the audit trail)
plus 9 database CHECK-constraint probes; `prisma migrate deploy` on an empty
database; a `prisma migrate diff` drift check; and finally a production build
whose every route is fetched and asserted on.

**Run `npm run verify:migrations` after any change to `schema.prisma`** — the
migrations are hand-written, so the drift check is what keeps them honest.

See [.verify/README.md](.verify/README.md) for what each script covers and two
quirks of the harness.

---

## How the business rules are enforced

### Profit is never stored

There is no profit column anywhere. Every figure in the app is derived at read
time:

```sql
revenue = SUM(sale.sale_price * sale.quantity)
profit  = SUM((sale.sale_price - batch.unit_cost) * sale.quantity)
```

Each sale points at the batch it consumed, and that batch supplies the unit cost.
Correct a batch's cost and the whole dashboard updates. All of this lives in
[`src/lib/queries.ts`](src/lib/queries.ts) as raw SQL, because the profit
expression spans two tables — something Prisma's `groupBy` cannot express, and
which would otherwise force loading every sale row into Node to sum in JS.

### Inventory can never go negative

Three independent layers, outermost first:

1. **The form** caps quantity at the selected batch's remaining stock and
   disables submit.
2. **The server action** re-validates everything and then performs the deduction
   as a single guarded `UPDATE`:
   ```sql
   UPDATE batches SET remaining_qty = remaining_qty - :qty
    WHERE id = :id AND is_deleted = false AND remaining_qty >= :qty
   ```
   If that matches zero rows, another sale drained the batch first and the whole
   transaction aborts. There is no read-then-write gap to lose a race in.
3. **The database** has `CHECK (remaining_qty >= 0)` and
   `CHECK (remaining_qty <= quantity)`, so even a hand-written `UPDATE` cannot
   corrupt stock.

### Double submits do not double-count

Each form mints an idempotency key per render, stored on a unique column. A
resubmit finds the existing row and reports it instead of creating a second stock
movement. If two requests race, the unique index rejects the loser and its
transaction rolls back — so the deduction happens exactly once.

### Nothing is hard-deleted

Batches, sales, areas and shops carry `is_deleted`. Deleting a sale also returns
its quantity to the batch, in the same transaction, so stock stays reconciled.
Deletion is refused where it would rewrite history: a batch with sales against
it, or an area or shop that sales are attributed to.

### Audit trail

Every batch, sale, product, area and shop write appends to `audit_logs`
(who / what / when / payload) inside the same transaction as the change, so the
log can never disagree with the data. The actor comes from `DEFAULT_ACTOR`;
replace `currentActor()` in [`src/lib/audit.ts`](src/lib/audit.ts) with a session
lookup when you add logins and every call site starts recording real users.

---

## Pages

| Route | What it does |
|---|---|
| `/dashboard` | KPI cards + 7 charts, filterable by year / category / area |
| `/batches/new` | Receive stock (inventory in) |
| `/sales/new` | Record a sale against a specific batch (inventory out) |
| `/batches` | All batches, filter by product and status |
| `/sales` | All sales with per-line profit and margin, filter by date range / area / product |
| `/products` | Catalog with live stock levels; add products, edit default prices, retire entries |
| `/areas` | Areas and their shops (CRUD) |

Filters live in the URL, so a filtered view can be bookmarked and shared, and
every chart is rendered server-side from the same parameters.

### The dashboard charts

1. **Monthly revenue & profit** — bars for revenue, line for profit, across all
   12 months.
2. **Revenue by packaging type** — Bottle / Tetra Pack / Bar.
3. **Revenue by volume size** — ordered 10g → 250ml → 500ml → 1000ml, not
   alphabetically.
4. **Revenue by flavor** — the five juices. With no category filter applied this
   chart scopes itself to Juice & Beverage so chocolate does not crowd out the
   flavors; an explicit category filter always wins.
5. **Category split** — donut, Juice & Beverage vs Chocolate, with the absolute
   total in the hole.
6. **Revenue & profit by area** — with a Year / Month toggle.
7. **Top shops** — highest revenue first. Direct sales with no shop get their own
   row so the totals still reconcile with the area chart.

Two deliberate charting decisions worth knowing about, both in
[`src/components/charts/theme.ts`](src/components/charts/theme.ts):

- **Revenue and profit always share one y-axis.** They are both money, so the
  gap between the profit line and the top of each revenue bar *is* the cost, read
  directly off the chart. A second axis would let the two series be scaled
  independently and make that gap meaningless.
- **Single-measure breakdowns are drawn in one colour.** Packaging, volume, flavor
  and shop are one series each; a colour per bar would encode nothing that bar
  length does not already say, and would force the reader through a legend.
  Values are labelled directly on the bars instead.

The two-colour series palette (blue `#2a78d6` / orange `#eb6834`) was validated
against the white card surface for lightness, chroma, protan/tritan separation,
normal-vision separation and 3:1 contrast.

---

## Project layout

```
prisma/
  schema.prisma                    # the data model
  migrations/
    20260101000000_init/           # tables, indexes, foreign keys
    20260101000100_business_constraints/
                                   # CHECK constraints + partial indexes
  seed.ts                          # 26 products, 4 areas, 7 shops (idempotent)
src/
  actions/                         # server actions: batches, sales, products, areas
  app/
    dashboard/ batches/ sales/ products/ areas/
  components/
    charts/                        # Recharts components + shared theme
    forms/                         # batch form, sale form, cascading product picker
    products/ areas/ dashboard/    # page-specific pieces
    ui/                            # shadcn/ui primitives
  lib/
    db.ts                          # Prisma singleton
    queries.ts                     # every dashboard aggregate (raw SQL)
    lists.ts                       # paginated batch and sale listings
    validations.ts                 # Zod schemas + SKU generation
    dates.ts                       # calendar-day handling
    audit.ts                       # audit log writer
    format.ts                      # money / quantity / date formatting
scripts/
  check-db.ts                      # npm run db:check - connection diagnostics
.verify/                           # integration suite (dev only, see .verify/README.md)
```

### Catalog and SKUs

A product is the unique combination of category + name + packaging + volume,
enforced by a unique index as well as a unique SKU. Adding a product without a
SKU generates one following the seeded convention — `deriveSku()` in
`src/lib/validations.ts` turns *Chocolate / Bar / 20g* into `CHO-BAR-20`.

The juice catalog in `prisma/seed.ts` is generated from a flavor list crossed
with a packaging/volume list, so adding a sixth flavor or a 2L bottle is a
one-line change there.

### Dates

`received_date` and `sale_date` are calendar days, not instants. They are
Postgres `DATE` columns, always built at UTC midnight, and always compared
against explicit `::date` literals in SQL — so the day you type is the day that
gets stored and grouped, whatever timezone the server runs in.

---

## Notes and things you may want to change

- **Seed catalog is 26 products, not 27.** The brief said 27, but the listed
  catalog is 5 flavors × 5 packaging/volume combinations (25) plus the 10g
  chocolate bar = 26. The seed matches the list you gave; add the 27th on the
  Products page if one is missing.
- **Default sale prices are placeholders** (250ml bottle $1.50, 500ml $2.50,
  1000ml $4.00, 250ml tetra $1.20, 500ml tetra $2.00, chocolate bar $0.50). Set
  your real prices on the Products page — editing a default never touches
  recorded sales, which keep the price they were sold at.
- **Currency is USD** via `Intl.NumberFormat` in `src/lib/format.ts`. Change it
  in that one file.
- **No authentication.** Anyone who can reach the app can write to it. Before
  employees use it, put it behind auth and swap `currentActor()` for the session
  user. The audit trail is already wired for this.
- **A sale draws from one batch.** Selling 500 units when the oldest batch has
  300 left means two sale lines. This is deliberate: it keeps every line's cost
  unambiguous. If you would rather have automatic FIFO splitting across batches,
  that is a change to `createSaleAction`.
- **Date inputs are native `<input type="date">`** rather than a calendar popover
  — fewer dependencies, and it gets the platform date picker and keyboard entry
  for free.
- **Indexing.** Sales are indexed on `(is_deleted, sale_date)`, `(area_id,
  sale_date)`, `(shop_id, sale_date)`, `(product_id, sale_date)` and `batch_id`,
  plus a partial index on live rows only, since every dashboard aggregate filters
  `is_deleted = false`. Batches have a partial index covering exactly the rows the
  "pick a batch" dropdown reads.
