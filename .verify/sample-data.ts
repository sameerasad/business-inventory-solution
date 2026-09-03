// Puts a little real data behind the pages for the smoke test.
import { prisma } from "@/lib/db";
import { emptyActionState } from "@/lib/validations";
import { createBatchAction } from "@/actions/batches";
import { createSaleAction } from "@/actions/sales";
import { createBookingAction } from "@/actions/bookings";
import { createBookerAction, setBookerAreasAction } from "@/actions/bookers";
import { recordPaymentAction } from "@/actions/payments";
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

  // Bookings, a booker with a territory, and a part payment. Without these the
  // Bookings, Bookers and Receivables pages render only their headers, so a
  // broken row would sail through the smoke test.
  const booker = await createBookerAction(
    emptyActionState,
    fd({ name: "Sample Booker", code: "S-01", phone: "0300-0000000" }),
  );
  if (!booker.ok) throw new Error(`booker failed: ${booker.message}`);
  const bookerRow = await prisma.booker.findFirstOrThrow({ where: { name: "Sample Booker" } });

  const territory = await setBookerAreasAction(
    emptyActionState,
    fd({
      bookerId: String(bookerRow.id),
      areaIds: JSON.stringify(areas.slice(0, 2).map((a) => a.id)),
    }),
  );
  if (!territory.ok) throw new Error(`territory failed: ${territory.message}`);

  const bookable = products[0]!;
  for (let n = 0; n < 2; n += 1) {
    const area = areas[n % areas.length]!;
    const shop = area.shops[0];
    const booked = await createBookingAction(
      emptyActionState,
      fd({
        bookerId: String(bookerRow.id),
        customerName: `Sample Customer ${n + 1}`,
        customerPhone: "0300-1112223",
        areaId: String(area.id),
        ...(shop ? { shopId: String(shop.id) } : {}),
        bookingDate: `${YEAR}-0${n + 2}-20`,
        lines: JSON.stringify([
          { productId: bookable.id, quantity: 12, unitPrice: Number(bookable.defaultSalePrice) },
        ]),
        idempotencyKey: `smoke-booking-${n}`,
      }),
    );
    if (!booked.ok) throw new Error(`booking failed: ${booked.message}`);
  }

  // One invoice part-paid, so Receivables has an outstanding balance to show and
  // the cash-basis dashboard has something recognised from a booking.
  const first = await prisma.booking.findFirstOrThrow({
    where: { idempotencyKey: "smoke-booking-0" },
  });
  const paid = await recordPaymentAction(
    emptyActionState,
    fd({
      bookingId: String(first.id),
      amount: Number(bookable.defaultSalePrice).toFixed(2),
      paidOn: `${YEAR}-02-25`,
      method: "Cash",
      idempotencyKey: "smoke-payment-0",
    }),
  );
  if (!paid.ok) throw new Error(`payment failed: ${paid.message}`);

  const [sales, bookings] = await Promise.all([prisma.sale.count(), prisma.booking.count()]);
  console.log(`sample data ready: ${sales} sales, ${bookings} bookings`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
