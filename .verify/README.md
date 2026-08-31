# Verification suite

Integration tests for the business rules, run against a **real Postgres** with no
database to install: [PGlite](https://pglite.dev) is Postgres compiled to
WebAssembly, exposed on a TCP socket so the actual Prisma client and the actual
server actions talk to it unchanged.

```bash
npm run typecheck          # tsc --noEmit
npm run verify             # migrations + seed + 106 data-layer checks + 9 constraint probes
npm run verify:migrations  # prisma migrate deploy works, and migrations match schema.prisma
npm run verify:pages       # builds, boots the server, fetches every page
npm run verify:all         # all of the above
```

It also powers `npm run dev:sandbox`, which runs the **app itself** against a
persistent PGlite database in `.verify/pgdata` so you can click through
everything without installing PostgreSQL. Note `maxConnections: 20` on the socket
server there — the library defaults to 1, which makes any dropped connection look
like the database vanished.

Nothing here ships to production, and nothing touches your real `DATABASE_URL` —
each script starts its own database (in memory for the verify scripts, on disk in
`.verify/pgdata` for the sandbox) and passes its own connection string to the
child process.

## What each script covers

| Script | File | Covers |
|---|---|---|
| `verify` | `verify.ts` | Applies both migrations, seeds, then drives the real server actions: batch creation, stock deduction, idempotent replays, oversell and cross-area/cross-product rejection, soft deletes returning stock, every dashboard aggregate checked against hand-computed totals, filter composition, stock levels, both listings, areas/shops CRUD, catalog additions, the audit trail. |
| `verify` (tail of `pglite-run.mjs`) | `pglite-run.mjs` | The database CHECK constraints, probed directly: negative stock, remaining > received, non-positive quantities, negative prices, duplicate SKU, duplicate shop-in-area. |
| `verify:migrations` | `migrate-check.mjs` | `prisma migrate deploy` on an empty database creates every table and constraint and records both migrations. |
| `verify:migrations` | `drift-check.mjs` | `prisma migrate diff` reports no difference between `prisma/migrations` and `schema.prisma`. Run this after **any** schema edit. |
| `verify:pages` | `smoke.mjs` | Production build, real server, every route returns 200 with the expected content — including the rendered value of pre-selected dropdowns (see below). |

## Two quirks worth knowing

**1. `next/cache` is stubbed.** The server actions call `revalidatePath()`, which
throws outside a Next request context. `tsconfig.verify.json` maps `next/cache`
to `next-cache-stub.ts`, which is why the verify scripts are run with
`tsx --tsconfig .verify/tsconfig.verify.json`.

**2. The PGlite socket dies on the first server-side error.** Any deliberate
constraint violation permanently closes it, so:

- tests that provoke a Postgres error run **last** in `verify.ts` (the duplicate
  SKU probe), and
- the CHECK-constraint probes bypass the socket entirely and run against PGlite
  directly at the end of `pglite-run.mjs`.

If you add a test that expects a database error, put it after everything else or
it will take the rest of the suite down with it. A failure reading
`Can't reach database server` usually means an earlier test tripped this.

## The dropdown assertions in `smoke.mjs`

Several markers look odd, e.g. `">All areas</span>"`. They are deliberate.

Radix displays a Select's chosen value by portaling the matching `SelectItem`'s
text into the trigger — but `SelectContent` is not mounted until the dropdown is
first opened, so a **pre-selected trigger renders completely blank**. That bug
shipped once during development (the dashboard showed three empty filters). The
fix is `SelectValueLabel` in `src/components/ui/select.tsx`, which passes the
label as children; these assertions are what stop it regressing.
