import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { BookingForm } from "@/components/forms/booking-form";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getBookableProducts } from "@/lib/bookings";
import { getAreasWithShops } from "@/lib/queries";
import { getActiveBookers } from "@/lib/bookers";

export const metadata: Metadata = { title: "New Booking" };
export const dynamic = "force-dynamic";

export default async function NewBookingPage() {
  const [products, areas, bookers] = await Promise.all([
    getBookableProducts(),
    getAreasWithShops(),
    getActiveBookers(),
  ]);

  const inStock = products.filter((p) => p.available > 0);
  const blocked = products.length === 0 ? "products" : areas.length === 0 ? "areas" : null;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="New booking"
        description="Take an order, and the sales are recorded and stock deducted automatically. An invoice is created that you can download as a PDF."
        action={
          <Button variant="outline" asChild>
            <Link href="/bookings">All bookings</Link>
          </Button>
        }
      />

      {blocked === "products" ? (
        <Alert tone="error">
          No active products. Add one on the{" "}
          <Link href="/products" className="font-medium underline">
            Products
          </Link>{" "}
          page first.
        </Alert>
      ) : blocked === "areas" ? (
        <Alert tone="error">
          Every booking needs an area. Add one on the{" "}
          <Link href="/areas" className="font-medium underline">
            Areas &amp; Shops
          </Link>{" "}
          page first.
        </Alert>
      ) : (
        <>
          {inStock.length === 0 ? (
            <Alert tone="error" className="mb-5">
              Nothing is in stock, so no order can be fulfilled.{" "}
              <Link href="/batches/new" className="font-medium underline">
                Receive a batch
              </Link>{" "}
              first.
            </Alert>
          ) : null}
          <BookingForm products={products} areas={areas} bookers={bookers} />
        </>
      )}
    </div>
  );
}
