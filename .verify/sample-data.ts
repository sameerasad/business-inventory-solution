// Puts a little real data behind the pages for the smoke test.
import { prisma } from "@/lib/db";
import { emptyActionState } from "@/lib/validations";
import { createBatchAction } from "@/actions/batches";
import { createSaleAction } from "@/actions/sales";
import { getAvailableBatchesForProduct } from "@/lib/queries";

function fd(values: Record<string, string>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(values)) form.append(k, v);
  return form;
}

const YEAR = new Date().getFullYear();

async function main() {
  const products = await prisma.product.findMany({
    where: { sku: { in: ["MNG-BTL-250", "MNG-TET-500", "APP-BTL-500", "CHO-BAR-10"] } },
  });
  const areas = await prisma.area.findMany({ orderBy: { name: "asc" }, include: { shops: true } });

  let i = 0;
  for (const product of products) {
    i += 1;
    const batch = await createBatchAction(
      emptyActionState,
      fd({
        productId: String(product.id),
        quantity: String(500 * i),
        unitCost: (0.4 + i * 0.15).toFixed(2),
        receivedDate: `${YEAR}-01-${String(5 + i).padStart(2, "0")}`,
        idempotencyKey: `smoke-batch-${product.sku}`,
      }),
    );
    if (!batch.ok) throw new Error(`batch failed: ${batch.message}`);

    const [available] = await getAvailableBatchesForProduct(product.id);
    for (let m = 0; m < 6; m += 1) {
      const area = areas[(i + m) % areas.length];
      const shop = area.shops[m % Math.max(1, area.shops.length)];
      const res = await createSaleAction(
        emptyActionState,
        fd({
          productId: String(product.id),
          batchId: String(available.id),
          areaId: String(area.id),
          ...(shop && m % 3 !== 0 ? { shopId: String(shop.id) } : {}),
          quantity: String(20 + m * 7),
          salePrice: Number(product.defaultSalePrice).toFixed(2),
          saleDate: `${YEAR}-${String(m * 2 + 1).padStart(2, "0")}-14`,
          idempotencyKey: `smoke-sale-${product.sku}-${m}`,
        }),
      );
      if (!res.ok) throw new Error(`sale failed: ${res.message}`);
    }
  }

  const sales = await prisma.sale.count();
  console.log(`sample data ready: ${sales} sales`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
