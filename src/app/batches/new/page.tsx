import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { BatchForm } from "@/components/forms/batch-form";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getProductOptions } from "@/lib/queries";

export const metadata: Metadata = { title: "New Batch" };
export const dynamic = "force-dynamic";

export default async function NewBatchPage() {
  const products = await getProductOptions();

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Receive stock"
        description="Creating a batch records what you received and what it cost you. Remaining quantity starts equal to the quantity received and is drawn down by sales."
        action={
          <Button variant="outline" asChild>
            <Link href="/batches">All batches</Link>
          </Button>
        }
      />

      {products.length === 0 ? (
        <Alert tone="error">
          No active products in the catalog. Add one on the{" "}
          <Link href="/products" className="font-medium underline">
            Products
          </Link>{" "}
          page, or run <code className="font-mono">npm run db:seed</code> to load the initial
          catalog.
        </Alert>
      ) : (
        <BatchForm products={products} />
      )}
    </div>
  );
}
