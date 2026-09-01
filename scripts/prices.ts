/**
 * Export and re-apply product prices.
 *
 *   npm run db:prices -- export    # write prisma/product-prices.json
 *   npm run db:prices -- apply     # read it back into the database
 *
 * Useful when moving to a new Neon project (or region): run db:deploy and
 * db:seed on the new database, then `apply` to restore the prices you had
 * tuned, instead of re-typing them on the Products page.
 *
 * Matches on SKU. Products in the file but not in the database are reported and
 * skipped, so this can never invent a product.
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient, Prisma } from "@prisma/client";

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

const FILE = path.join("prisma", "product-prices.json");

type Row = { sku: string; name: string; defaultSalePrice: string };

async function main(): Promise<number> {
  loadDotEnv();
  const mode = process.argv[2];
  if (mode !== "export" && mode !== "apply") {
    console.error("\nUsage:\n  npm run db:prices -- export\n  npm run db:prices -- apply\n");
    return 1;
  }

  const prisma = new PrismaClient({ log: ["error"] });

  try {
    if (mode === "export") {
      const products = await prisma.product.findMany({
        select: { sku: true, name: true, defaultSalePrice: true },
        orderBy: { sku: "asc" },
      });
      const rows: Row[] = products.map((p) => ({
        sku: p.sku,
        name: p.name,
        defaultSalePrice: p.defaultSalePrice.toString(),
      }));
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(rows, null, 2) + "\n");
      console.log(`\nWrote ${rows.length} product prices to ${FILE}\n`);
      for (const r of rows) {
        console.log(`  ${r.sku.padEnd(14)} ${String(r.defaultSalePrice).padStart(8)}   ${r.name}`);
      }
      console.log("");
      return 0;
    }

    if (!fs.existsSync(FILE)) {
      console.error(`\n${FILE} not found. Run "npm run db:prices -- export" first.\n`);
      return 1;
    }
    const rows: Row[] = JSON.parse(fs.readFileSync(FILE, "utf8"));

    let updated = 0;
    let unchanged = 0;
    const missing: string[] = [];

    for (const row of rows) {
      const existing = await prisma.product.findUnique({
        where: { sku: row.sku },
        select: { id: true, defaultSalePrice: true },
      });
      if (!existing) {
        missing.push(row.sku);
        continue;
      }
      if (existing.defaultSalePrice.toString() === row.defaultSalePrice) {
        unchanged += 1;
        continue;
      }
      await prisma.product.update({
        where: { id: existing.id },
        data: { defaultSalePrice: new Prisma.Decimal(row.defaultSalePrice) },
      });
      updated += 1;
    }

    console.log(`\nApplied prices from ${FILE}`);
    console.log(`  updated   : ${updated}`);
    console.log(`  unchanged : ${unchanged}`);
    if (missing.length) {
      console.log(`  skipped (no such SKU in this database): ${missing.join(", ")}`);
    }
    console.log("");
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n").find((l) => l.trim()) : err;
    console.error(`\nFailed: ${message}\n`);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().then((code) => process.exit(code));
