/**
 * Seed script - idempotent. Safe to re-run; it upserts on natural keys
 * (category name, product SKU, area name, shop name-within-area) so it never
 * duplicates rows and never touches batches or sales.
 *
 *   npm run db:seed
 */
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

const CATEGORY_JUICE = "Juice & Beverage";
const CATEGORY_CHOCOLATE = "Chocolate";

type SeedProduct = {
  category: string;
  name: string;
  packagingType: string;
  variantValue: string;
  sku: string;
  unit: string;
  defaultSalePrice: string;
};

/**
 * Juice catalog is generated from (flavor x packaging/volume) so adding a flavor
 * or a volume later is a one-line change.
 */
const FLAVORS: { name: string; code: string }[] = [
  { name: "Mango Juice", code: "MNG" },
  { name: "Apple Juice", code: "APP" },
  { name: "Peach Juice", code: "PCH" },
  { name: "Lychee Juice", code: "LYC" },
  { name: "Pomegranate Juice", code: "POM" },
];

/**
 * Placeholder sale prices, in PKR (rupees). They are only used for products that
 * do not exist yet - the seed never overwrites a price you have edited in the
 * app, so a reseed cannot undo your real pricing.
 */
const JUICE_VARIANTS: {
  packagingType: string;
  packagingCode: string;
  variantValue: string;
  variantCode: string;
  unit: string;
  defaultSalePrice: string;
}[] = [
  { packagingType: "Bottle", packagingCode: "BTL", variantValue: "250ml", variantCode: "250", unit: "bottle", defaultSalePrice: "60" },
  { packagingType: "Bottle", packagingCode: "BTL", variantValue: "500ml", variantCode: "500", unit: "bottle", defaultSalePrice: "100" },
  { packagingType: "Bottle", packagingCode: "BTL", variantValue: "1000ml", variantCode: "1000", unit: "bottle", defaultSalePrice: "180" },
  { packagingType: "Tetra Pack", packagingCode: "TET", variantValue: "250ml", variantCode: "250", unit: "tetra_pack", defaultSalePrice: "50" },
  { packagingType: "Tetra Pack", packagingCode: "TET", variantValue: "500ml", variantCode: "500", unit: "tetra_pack", defaultSalePrice: "90" },
];

const PRODUCTS: SeedProduct[] = [
  ...FLAVORS.flatMap((flavor) =>
    JUICE_VARIANTS.map((v) => ({
      category: CATEGORY_JUICE,
      name: flavor.name,
      packagingType: v.packagingType,
      variantValue: v.variantValue,
      sku: `${flavor.code}-${v.packagingCode}-${v.variantCode}`,
      unit: v.unit,
      defaultSalePrice: v.defaultSalePrice,
    })),
  ),
  {
    category: CATEGORY_CHOCOLATE,
    name: "Chocolate",
    packagingType: "Bar",
    variantValue: "10g",
    sku: "CHO-BAR-10",
    unit: "bar",
    defaultSalePrice: "20",
  },
];

const AREAS_WITH_SHOPS: { area: string; shops: string[] }[] = [
  { area: "Downtown", shops: ["Central Mart", "Corner Store", "City Grocers"] },
  { area: "North Zone", shops: ["Northside Supermarket", "Hillview Kiosk"] },
  { area: "South Zone", shops: ["Southgate Bazaar", "Riverside Shop"] },
  { area: "Online", shops: [] },
];

async function main() {
  // --- Categories ---
  const categories = new Map<string, number>();
  for (const name of [CATEGORY_JUICE, CATEGORY_CHOCOLATE]) {
    const row = await prisma.category.upsert({
      where: { name },
      update: {},
      create: { name },
    });
    categories.set(name, row.id);
  }
  console.log(`Categories ready: ${[...categories.keys()].join(", ")}`);

  // --- Products ---
  // SKU is the natural key. On re-run we refresh the descriptive fields but
  // deliberately leave default_sale_price alone, so prices you tuned in the UI
  // survive a reseed.
  let created = 0;
  for (const p of PRODUCTS) {
    const categoryId = categories.get(p.category);
    if (!categoryId) throw new Error(`Unknown category ${p.category}`);
    const existing = await prisma.product.findUnique({ where: { sku: p.sku } });
    if (existing) {
      await prisma.product.update({
        where: { sku: p.sku },
        data: {
          categoryId,
          name: p.name,
          packagingType: p.packagingType,
          variantValue: p.variantValue,
          unit: p.unit,
          isActive: true,
        },
      });
    } else {
      await prisma.product.create({
        data: {
          categoryId,
          name: p.name,
          packagingType: p.packagingType,
          variantValue: p.variantValue,
          sku: p.sku,
          unit: p.unit,
          defaultSalePrice: new Prisma.Decimal(p.defaultSalePrice),
        },
      });
      created += 1;
    }
  }
  console.log(`Products: ${PRODUCTS.length} in catalog (${created} newly created)`);

  // --- Areas + Shops ---
  for (const entry of AREAS_WITH_SHOPS) {
    const area = await prisma.area.upsert({
      where: { name: entry.area },
      update: { isDeleted: false },
      create: { name: entry.area },
    });
    for (const shopName of entry.shops) {
      await prisma.shop.upsert({
        where: { areaId_name: { areaId: area.id, name: shopName } },
        update: { isDeleted: false },
        create: { areaId: area.id, name: shopName },
      });
    }
  }
  const areaCount = await prisma.area.count();
  const shopCount = await prisma.shop.count();
  console.log(`Areas: ${areaCount}, Shops: ${shopCount}`);
  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
