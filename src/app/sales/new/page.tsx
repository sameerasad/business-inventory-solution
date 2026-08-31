import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { SaleForm } from "@/components/forms/sale-form";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getAreasWithShops, getProductOptions } from "@/lib/queries";

export const metadata: Metadata = { title: "New Sale" };
export const dynamic = "force-dynamic";

export default async function NewSalePage() {
  const [products, areas] = await Promise.all([getProductOptions(), getAreasWithShops()]);

  const blocked =
    products.length === 0 ? "products" : areas.length === 0 ? "areas" : null;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Record a sale"
        description="A sale draws down one specific batch. That batch supplies the unit cost, which is what profit is calculated against."
        action={
          <Button variant="outline" asChild>
            <Link href="/sales">All sales</Link>
          </Button>
        }
      />

      {blocked === "products" ? (
        <Alert tone="error">
          No active products in the catalog. Add one on the{" "}
          <Link href="/products" className="font-medium underline">
            Products
          </Link>{" "}
          page, or run <code className="font-mono">npm run db:seed</code>.
        </Alert>
      ) : blocked === "areas" ? (
        <Alert tone="error">
          Every sale needs an area. Add at least one on the{" "}
          <Link href="/areas" className="font-medium underline">
            Areas &amp; Shops
          </Link>{" "}
          page first.
        </Alert>
      ) : (
        <SaleForm products={products} areas={areas} />
      )}
    </div>
  );
}
