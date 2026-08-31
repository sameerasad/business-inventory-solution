import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { AddProductDialog } from "@/components/products/add-product-dialog";
import { ProductRowActions } from "@/components/products/product-row-actions";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { money, qty } from "@/lib/format";
import { getCategories, getStockLevels } from "@/lib/queries";

export const metadata: Metadata = { title: "Products" };
export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const [rows, categories] = await Promise.all([getStockLevels(), getCategories()]);

  // Existing values feed the "add product" suggestions so the catalog stays tidy.
  const packagingTypes = [...new Set(rows.map((r) => r.packagingType))].sort();
  const variantValues = [...new Set(rows.map((r) => r.variantValue))].sort();
  const units = [...new Set(rows.map((r) => r.unit))].sort();

  const totalStock = rows.reduce((sum, r) => sum + r.currentStock, 0);
  const stockValue = rows.reduce((sum, r) => sum + r.currentStock * (r.avgUnitCost ?? 0), 0);
  const outOfStock = rows.filter((r) => r.currentStock === 0 && r.isActive).length;

  return (
    <div>
      <PageHeader
        title="Products"
        description={`${rows.length} catalog entries. Current stock is the sum of remaining quantity across every live batch for that product.`}
        action={
          <AddProductDialog
            categories={categories}
            packagingTypes={packagingTypes}
            variantValues={variantValues}
            units={units}
          />
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <SummaryTile label="Units in stock" value={qty(totalStock)} />
        <SummaryTile
          label="Stock value at cost"
          value={money(stockValue)}
          hint="Weighted average cost of remaining units"
        />
        <SummaryTile label="Active products with no stock" value={String(outOfStock)} />
      </div>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>SKU</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Packaging</TableHead>
              <TableHead>Volume</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Default price</TableHead>
              <TableHead className="text-right">Avg cost</TableHead>
              <TableHead className="text-right">Current stock</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                  No products yet. Run <code className="font-mono">npm run db:seed</code> to load
                  the initial catalog, or add one above.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.productId} className={row.isActive ? undefined : "opacity-60"}>
                  <TableCell className="font-mono text-xs">{row.sku}</TableCell>
                  <TableCell className="whitespace-nowrap font-medium">
                    {row.name}
                    {!row.isActive ? (
                      <Badge variant="outline" className="ml-2">
                        Retired
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{row.packagingType}</TableCell>
                  <TableCell className="whitespace-nowrap">{row.variantValue}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {row.categoryName}
                  </TableCell>
                  <TableCell className="num text-right">{money(row.defaultSalePrice)}</TableCell>
                  <TableCell className="num text-right text-muted-foreground">
                    {row.avgUnitCost == null ? "-" : money(row.avgUnitCost)}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="num font-medium">{qty(row.currentStock)}</span>
                    <span className="ml-1 text-xs text-muted-foreground">{row.unit}</span>
                    {row.currentStock === 0 ? (
                      <Badge variant="destructive" className="ml-2">
                        Out
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    <ProductRowActions
                      productId={row.productId}
                      sku={row.sku}
                      defaultSalePrice={row.defaultSalePrice}
                      isActive={row.isActive}
                      hasHistory={row.batchCount > 0}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
          {rows.length > 0 ? (
            <TableFooter>
              <TableRow>
                <TableCell colSpan={7} className="text-xs uppercase tracking-wide">
                  Total
                </TableCell>
                <TableCell className="num text-right font-semibold">{qty(totalStock)}</TableCell>
                <TableCell />
              </TableRow>
            </TableFooter>
          ) : null}
        </Table>
      </Card>

      <p className="mt-4 text-xs text-muted-foreground">
        Need to bring stock in? Go to{" "}
        <Link href="/batches/new" className="underline">
          New Batch
        </Link>
        .
      </p>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card className="p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="num mt-1.5 text-xl font-semibold">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </Card>
  );
}
