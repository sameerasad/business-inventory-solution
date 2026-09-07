import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { ListFilters, type FilterSpec } from "@/components/list-filters";
import { AddProductDialog } from "@/components/products/add-product-dialog";
import { ProductRowActions } from "@/components/products/product-row-actions";
import { EditProductDialog } from "@/components/products/edit-product-dialog";
import { CategoryManager } from "@/components/products/category-manager";
import { HardDeleteButton } from "@/components/forms/edit-dialog";
import { deleteProductAction } from "@/actions/products";
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
import { prisma } from "@/lib/db";

export const metadata: Metadata = { title: "Products" };
export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = (first(sp.q) ?? "").trim();
  const categoryParam = first(sp.category);
  const packagingParam = first(sp.packaging);
  const stockParam = first(sp.stock);

  const [allRows, categories, categoryCounts] = await Promise.all([
    getStockLevels(),
    getCategories(),
    prisma.category.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, _count: { select: { products: true } } },
    }),
  ]);

  // The suggestion lists and the filter options come from the WHOLE catalog,
  // not the filtered view - otherwise choosing one packaging would remove every
  // other packaging from the dropdown that chose it.
  const packagingTypes = [...new Set(allRows.map((r) => r.packagingType))].sort();
  const variantValues = [...new Set(allRows.map((r) => r.variantValue))].sort();
  const units = [...new Set(allRows.map((r) => r.unit))].sort();

  // Filtered here rather than in the query: the catalog is a few dozen rows
  // that are already loaded, so a round trip per keystroke would buy nothing.
  const needle = q.toLowerCase();
  const rows = allRows.filter((r) => {
    if (needle) {
      const haystack = [r.sku, r.name, r.packagingType, r.variantValue, r.categoryName]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (categoryParam && categoryParam !== "all" && String(r.categoryId) !== categoryParam) {
      return false;
    }
    if (packagingParam && packagingParam !== "all" && r.packagingType !== packagingParam) {
      return false;
    }
    if (stockParam === "in" && r.currentStock <= 0) return false;
    if (stockParam === "out" && r.currentStock > 0) return false;
    if (stockParam === "inactive" && r.isActive) return false;
    return true;
  });

  const filters: FilterSpec[] = [
    {
      kind: "search",
      key: "q",
      label: "Search",
      value: q,
      placeholder: "Name, SKU, size, category",
      width: "w-[280px]",
    },
    {
      kind: "select",
      key: "category",
      label: "Category",
      value: categoryParam ?? "all",
      allLabel: "All categories",
      width: "w-[200px]",
      options: categoryCounts.map((c) => ({ value: String(c.id), label: c.name })),
    },
    {
      kind: "select",
      key: "packaging",
      label: "Packaging",
      value: packagingParam ?? "all",
      allLabel: "All packaging",
      width: "w-[180px]",
      options: packagingTypes.map((t) => ({ value: t, label: t })),
    },
    {
      kind: "select",
      key: "stock",
      label: "Stock",
      value: stockParam ?? "all",
      allLabel: "Any",
      width: "w-[170px]",
      options: [
        { value: "in", label: "In stock" },
        { value: "out", label: "Out of stock" },
        { value: "inactive", label: "Inactive" },
      ],
    },
  ];

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

      <ListFilters filters={filters} />

      <div className="mb-5">
        <h2 className="mb-2 text-sm font-semibold">Categories</h2>
        <CategoryManager
          categories={categoryCounts.map((c) => ({
            id: c.id,
            name: c.name,
            products: c._count.products,
          }))}
        />
      </div>

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
                    <div className="flex items-center justify-end gap-0.5">
                      <EditProductDialog
                        product={{
                          id: row.productId,
                          sku: row.sku,
                          name: row.name,
                          categoryId: row.categoryId,
                          packagingType: row.packagingType,
                          variantValue: row.variantValue,
                          unit: row.unit,
                          defaultSalePrice: row.defaultSalePrice,
                        }}
                        categories={categories}
                        packagingTypes={packagingTypes}
                        variantValues={variantValues}
                        units={units}
                      />
                      <ProductRowActions
                        productId={row.productId}
                        sku={row.sku}
                        defaultSalePrice={row.defaultSalePrice}
                        isActive={row.isActive}
                        hasHistory={row.batchCount > 0}
                      />
                      <HardDeleteButton
                        action={deleteProductAction}
                        id={row.productId}
                        title={`Delete ${row.sku}?`}
                        description="Removed for good. Only possible because nothing points at it - no batch, no sale."
                        disabled={row.totalBatches > 0 || row.totalSales > 0}
                        disabledReason={`${row.totalBatches} batch(es) and ${row.totalSales} sale(s) reference this product. Retire it instead.`}
                      />
                    </div>
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

function SummaryTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="num mt-1.5 text-xl font-semibold">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </Card>
  );
}
