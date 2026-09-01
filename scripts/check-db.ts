/**
 * Answers one question: "is my database connected and set up correctly?"
 *
 *   npm run db:check
 *
 * Reads .env (or the real environment, which wins), checks the two connection
 * strings for the mistakes that actually happen with pooled providers like Neon,
 * connects, and reports whether the migrations and seed have been applied.
 * No dependencies beyond what the app already uses.
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

/* --------------------------------------------------------------- .env loading */

// Prisma's CLI loads .env for you; a plain tsx script does not. Minimal parser:
// KEY=value, optional quotes, # comments, blank lines. The real environment wins.
function loadDotEnv(file = ".env"): void {
  const full = path.join(process.cwd(), file);
  if (!fs.existsSync(full)) return;
  for (const raw of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/* ------------------------------------------------------------------ reporting */

let problems = 0;
let warnings = 0;

const pass = (m: string) => console.log(`  [ok]   ${m}`);
const warn = (m: string) => {
  warnings += 1;
  console.log(`  [warn] ${m}`);
};
const fail = (m: string) => {
  problems += 1;
  console.log(`  [FAIL] ${m}`);
};

/** Never print the password. */
function redact(url: string): string {
  return url.replace(/\/\/([^:/@]+):([^@]*)@/, "//$1:****@");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable)";
  }
}

/** Neon pooled hosts contain "-pooler"; Supabase's transaction pooler is port 6543. */
function looksPooled(url: string): boolean {
  return /-pooler\.|:6543\b/.test(url);
}

const EXPECTED_TABLES = [
  "categories",
  "areas",
  "shops",
  "products",
  "batches",
  "sales",
  "audit_logs",
];

async function main(): Promise<number> {
  loadDotEnv();

  console.log("\nChecking the database configuration\n");

  /* ----------------------------------------------------- 1. connection strings */

  console.log("Connection strings");

  const runtimeUrl = process.env.DATABASE_URL;
  const cliUrl = process.env.DATABASE_URL_UNPOOLED;

  if (!runtimeUrl) {
    fail("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  } else if (!/^postgres(ql)?:\/\//.test(runtimeUrl)) {
    fail(`DATABASE_URL is not a PostgreSQL URL: ${redact(runtimeUrl)}`);
  } else {
    pass(`DATABASE_URL -> ${hostOf(runtimeUrl)}`);
  }

  if (!cliUrl) {
    fail(
      "DATABASE_URL_UNPOOLED is not set. The Prisma CLI needs it (migrate/studio).\n" +
        "         Against one plain PostgreSQL server, set it to the same value as DATABASE_URL.",
    );
  } else {
    pass(`DATABASE_URL_UNPOOLED -> ${hostOf(cliUrl)}`);
  }

  // The pooled/direct mix-ups that actually break deployments.
  if (runtimeUrl) {
    const hasPgBouncerFlag = /[?&]pgbouncer=true\b/.test(runtimeUrl);

    if (looksPooled(runtimeUrl) && !hasPgBouncerFlag) {
      fail(
        "DATABASE_URL points at a POOLED endpoint but is missing pgbouncer=true.\n" +
          '         Without it you get intermittent \'prepared statement "s0" already exists\'.\n' +
          "         Append &pgbouncer=true&connection_limit=1",
      );
    } else if (looksPooled(runtimeUrl)) {
      pass("DATABASE_URL is pooled and has pgbouncer=true (correct for serverless)");
    } else if (/\.neon\.tech/.test(runtimeUrl)) {
      warn(
        "DATABASE_URL is a Neon DIRECT endpoint. Fine locally, but on Vercel use the\n" +
          "         pooled host (same host with '-pooler') plus &pgbouncer=true.",
      );
    } else {
      pass("DATABASE_URL is a direct connection (expected for a local server)");
    }

    if (/\.neon\.tech|supabase\.com/.test(runtimeUrl) && !/sslmode=require/.test(runtimeUrl)) {
      warn("Hosted providers require SSL - add ?sslmode=require to DATABASE_URL.");
    }
    if (/channel_binding=/.test(runtimeUrl)) {
      warn("Drop channel_binding from DATABASE_URL; keep sslmode=require.");
    }
  }

  if (cliUrl && looksPooled(cliUrl)) {
    fail(
      "DATABASE_URL_UNPOOLED points at a POOLED endpoint. Migrations need a direct\n" +
        "         connection - use the host WITHOUT '-pooler' (Neon) or port 5432 (Supabase).",
    );
  } else if (cliUrl) {
    pass("DATABASE_URL_UNPOOLED is a direct connection (correct for migrations)");
  }

  if (problems > 0) {
    console.log(`\n${problems} problem(s) found. Fix the above and run this again.\n`);
    return 1;
  }

  /* ---------------------------------------------------------- 2. connectivity */

  console.log("\nConnectivity");

  const prisma = new PrismaClient({ log: ["error"] });
  try {
    const started = Date.now();
    const rows = await prisma.$queryRaw<
      { db: string; usr: string; version: string }[]
    >`SELECT current_database() AS db, current_user AS usr, version() AS version`;
    const info = rows[0];
    pass(`connected in ${Date.now() - started}ms`);
    pass(`database "${info.db}" as user "${info.usr}"`);
    pass(info.version.split(" ").slice(0, 2).join(" "));

    /* ------------------------------------------------------------ 3. schema */

    console.log("\nSchema");

    const tableRows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `;
    const present = new Set(tableRows.map((r) => r.table_name));
    const missing = EXPECTED_TABLES.filter((t) => !present.has(t));

    if (missing.length > 0) {
      fail(
        missing.length === EXPECTED_TABLES.length
          ? "no application tables found - the migrations have not been applied."
          : `missing table(s): ${missing.join(", ")}`,
      );
      // Which command actually helps depends on whether Prisma thinks these
      // migrations already ran. If the ledger says they did, `migrate deploy`
      // reports "up to date" and changes nothing - which is what happens when a
      // table was dropped by hand. db:repair is the way back from that.
      let ledgerClaimsApplied = false;
      try {
        const applied = await prisma.$queryRaw<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
        `;
        ledgerClaimsApplied = applied[0].n > 0;
      } catch {
        // No _prisma_migrations table - nothing has ever been applied.
      }

      if (ledgerClaimsApplied) {
        console.log(
          "\n  Prisma's migration ledger says these migrations already ran, so\n" +
            '  "npm run db:deploy" will report "up to date" and change nothing.\n' +
            "  A table was most likely dropped by hand.\n" +
            "\n  Run:  npm run db:repair\n",
        );
      } else {
        console.log("\n  Run:  npm run db:deploy\n");
      }
      return 1;
    }
    pass(`all ${EXPECTED_TABLES.length} tables present`);

    const checkRows = await prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM pg_constraint
       WHERE contype = 'c' AND connamespace = 'public'::regnamespace
    `;
    if (checkRows[0].n >= 7) {
      pass(`${checkRows[0].n} CHECK constraints in place (the no-negative-stock guards)`);
    } else {
      warn(
        `only ${checkRows[0].n} CHECK constraints found - the business_constraints\n` +
          "         migration may be missing. Run: npm run db:deploy",
      );
    }

    /* -------------------------------------------------------------- 4. data */

    console.log("\nData");

    const [products, categories, areas, shops, batches, sales] = await Promise.all([
      prisma.product.count(),
      prisma.category.count(),
      prisma.area.count(),
      prisma.shop.count(),
      prisma.batch.count(),
      prisma.sale.count(),
    ]);

    if (products === 0) {
      warn("no products yet - the catalog has not been seeded. Run: npm run db:seed");
    } else {
      pass(`${products} products, ${categories} categories, ${areas} areas, ${shops} shops`);
    }
    pass(`${batches} batches, ${sales} sales recorded`);

    /* ----------------------------------------------------------- 5. verdict */

    console.log("");
    console.log(
      warnings > 0
        ? `Connected and usable, with ${warnings} thing(s) to look at above.`
        : "Connected and set up correctly.",
    );
    console.log(
      products === 0
        ? "Next:  npm run db:seed   then   npm run dev\n"
        : "Next:  npm run dev   then open http://localhost:3000\n",
    );
    return 0;
  } catch (err) {
    // Prisma error messages open with blank lines and an echo of the call site,
    // so take the first line that actually says something.
    const first =
      (err instanceof Error ? err.message : String(err))
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith("Invalid `")) ?? "unknown error";
    fail(`could not connect: ${first}`);
    console.log(
      "\n  Common causes:\n" +
        "   - the database server is not running (local setups)\n" +
        "   - wrong password, or a password containing @ : / ? # that needs URL-encoding\n" +
        "   - missing ?sslmode=require on a hosted provider\n" +
        "   - host unreachable from here (firewall, or wrong region/host)\n",
    );
    return 1;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
