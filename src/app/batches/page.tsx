import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { FilterBarSkeleton } from "@/components/filter-bar-skeleton";
import { ListFilters, type FilterSpec } from "@/components/list-filters";
import { Pagination } from "@/components/pagination";
import { SoftDeleteButton } from "@/components/forms/soft-delete-button";
import { softDeleteBatchAction } from "@/actions/batches";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { dateOnly, money, qty } from "@/lib/format";
import { getBatchList, PAGE_SIZE, type BatchStatusFilter } from "@/lib/lists";
import { getProductOptions } from "@/lib/queries";

export const metadata: Metadata = { title: "Batches" };
export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function BatchesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const productParam = first(sp.product);
  const statusParam = first(sp.status);
  const pageParam = Number.parseInt(first(sp.page) ?? "1", 10);

  const productId = productParam ? Number.parseInt(productParam, 10) : null;
  const status: BatchStatusFilter =
    statusParam === "active" || statusParam === "depleted" ? statusParam : "all";

  const [products, list] = await Promise.all([
    getProductOptions(),
    getBatchList({
      productId: Number.isInteger(productId) && productId! > 0 ? productId : null,
      status,
      page: Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1,
    }),
  ]);

  const filters: FilterSpec[] = [
    {
      kind: "select",
      key: "product",
      label: "Product",
      value: productParam ?? "all",
      allLabel: "All products",
      width: "w-[280px]",
      options: products.map((p) => ({
        value: String(p.id),
        label: `${p.sku} - ${p.name} ${p.packagingType} ${p.variantValue}`,
      })),
    },
    {
      kind: "select",
      key: "status",
      label: "Status",
      value: status,
      allLabel: "All",
      width: "w-[160px]",
      options: [
        { value: "active", label: "Active (stock left)" },
        { value: "depleted", label: "Depleted" },
      ],
    },
  ];

  return (
    <div>
      <PageHeader
        title="Batches"
        description="Every stock receipt, with how much of it is still unsold. A depleted batch stays here and stays attached to its sales - it just drops out of the New Sale picker."
        action={
          <Button asChild>
            <Link href="/batches/new">Receive stock</Link>
          </Button>
        }
      />

      <Suspense fallback={<FilterBarSkeleton className="mb-4 h-[76px] animate-pulse rounded-lg border bg-card" />}>
        <ListFilters filters={filters} />
      </Suspense>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Batch</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead className="text-right">Received</TableHead>
              <TableHead className="text-right">Sold</TableHead>
              <TableHead className="text-right">Remaining</TableHead>
              <TableHead className="text-right">Unit cost</TableHead>
              <TableHead className="text-right">Batch cost</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Added by</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={12} className="py-10 text-center text-muted-foreground">
                  No batches match these filters.{" "}
                  <Link href="/batches/new" className="underline">
                    Receive stock
                  </Link>
                  .
                </TableCell>
              </TableRow>
            ) : (
              list.rows.map((row) => {
                const depleted = row.remainingQty === 0;
                return (
                  <TableRow key={row.id}>
                    <TableCell className="num font-medium">#{row.id}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {row.productName}
                      <span className="ml-1 text-xs text-muted-foreground">
                        {row.packagingType} {row.variantValue}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.sku}</TableCell>
                    <TableCell className="num text-right">{qty(row.quantity)}</TableCell>
                    <TableCell className="num text-right text-muted-foreground">
                      {qty(row.soldQty)}
                    </TableCell>
                    <TableCell className="num text-right font-medium">
                      {qty(row.remainingQty)}
                    </TableCell>
                    <TableCell className="num text-right">{money(row.unitCost)}</TableCell>
                    <TableCell className="num text-right text-muted-foreground">
                      {money(row.totalCost)}
                    </TableCell>
                    <TableCell className="num whitespace-nowrap">
                      {dateOnly(row.receivedDate)}
                    </TableCell>
                    <TableCell>
                      {depleted ? (
                        <Badge variant="secondary">Depleted</Badge>
                      ) : (
                        <Badge variant="success">Active</Badge>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {row.createdBy}
                    </TableCell>
                    <TableCell className="text-right">
                      <SoftDeleteButton
                        action={softDeleteBatchAction}
                        id={row.id}
                        title={`Remove batch #${row.id}`}
                        description={
                          row.salesCount > 0
                            ? `This batch has ${row.salesCount} sale(s) against it, so it cannot be removed. Delete those sales first.`
                            : `${row.sku}, ${qty(row.quantity)} received at ${money(row.unitCost)} each. The row is kept and flagged as deleted, not erased.`
                        }
                      />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      <Pagination
        page={list.page}
        pageCount={list.pageCount}
        total={list.total}
        pageSize={PAGE_SIZE}
        basePath="/batches"
        params={{ product: productParam, status: statusParam }}
      />
    </div>
  );
}
