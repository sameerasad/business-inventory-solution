import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { FilterBarSkeleton } from "@/components/filter-bar-skeleton";
import { ListFilters, type FilterSpec } from "@/components/list-filters";
import { Pagination } from "@/components/pagination";
import { SoftDeleteButton } from "@/components/forms/soft-delete-button";
import { softDeleteSaleAction } from "@/actions/sales";
import { Alert } from "@/components/ui/alert";
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
import { isDateOnly } from "@/lib/dates";
import { getSaleList, PAGE_SIZE } from "@/lib/lists";
import { getProductOptions } from "@/lib/queries";
import { prisma } from "@/lib/db";

export const metadata: Metadata = { title: "Sales" };
export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseId(value: string | undefined): number | null {
  if (!value || value === "all") return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const fromParam = first(sp.from);
  const toParam = first(sp.to);
  const areaParam = first(sp.area);
  const productParam = first(sp.product);
  const pageParam = Number.parseInt(first(sp.page) ?? "1", 10);

  // A malformed date in the URL should narrow nothing rather than 500 the page.
  const from = fromParam && isDateOnly(fromParam) ? fromParam : null;
  const to = toParam && isDateOnly(toParam) ? toParam : null;
  const invalidRange = from != null && to != null && from > to;

  const [products, areas, list] = await Promise.all([
    getProductOptions(),
    prisma.area.findMany({
      where: { isDeleted: false },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    getSaleList({
      from: invalidRange ? null : from,
      to: invalidRange ? null : to,
      areaId: parseId(areaParam),
      productId: parseId(productParam),
      page: Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1,
    }),
  ]);

  const filters: FilterSpec[] = [
    { kind: "date", key: "from", label: "From", value: from ?? "", width: "w-[160px]" },
    { kind: "date", key: "to", label: "To", value: to ?? "", width: "w-[160px]" },
    {
      kind: "select",
      key: "area",
      label: "Area",
      value: areaParam ?? "all",
      allLabel: "All areas",
      width: "w-[180px]",
      options: areas.map((a) => ({ value: String(a.id), label: a.name })),
    },
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
  ];

  return (
    <div>
      <PageHeader
        title="Sales"
        description="Profit on each line is the sale price minus the unit cost of the batch it came from, times the quantity. It is calculated on read, never stored."
        action={
          <Button asChild>
            <Link href="/sales/new">Record a sale</Link>
          </Button>
        }
      />

      <Suspense fallback={<FilterBarSkeleton className="mb-4 h-[76px] animate-pulse rounded-lg border bg-card" />}>
        <ListFilters filters={filters} />
      </Suspense>

      {invalidRange ? (
        <Alert tone="error" className="mb-4">
          The From date is after the To date, so the date filter was ignored.
        </Alert>
      ) : null}

      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <Tile label="Revenue (filtered)" value={money(list.totals.revenue)} />
        <Tile
          label="Profit (filtered)"
          value={money(list.totals.profit)}
          tone={list.totals.profit < 0 ? "loss" : "gain"}
        />
        <Tile label="Units (filtered)" value={qty(list.totals.units)} />
      </div>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>Batch</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Sale price</TableHead>
              <TableHead className="text-right">Unit cost</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
              <TableHead className="text-right">Profit</TableHead>
              <TableHead className="text-right">Margin</TableHead>
              <TableHead>Area</TableHead>
              <TableHead>Shop</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={13} className="py-10 text-center text-muted-foreground">
                  No sales match these filters.{" "}
                  <Link href="/sales/new" className="underline">
                    Record a sale
                  </Link>
                  .
                </TableCell>
              </TableRow>
            ) : (
              list.rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="num whitespace-nowrap">{dateOnly(row.saleDate)}</TableCell>
                  <TableCell className="font-mono text-xs">{row.sku}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {row.productName}
                    <span className="ml-1 text-xs text-muted-foreground">
                      {row.packagingType} {row.variantValue}
                    </span>
                  </TableCell>
                  <TableCell className="num text-muted-foreground">#{row.batchId}</TableCell>
                  <TableCell className="num text-right">{qty(row.quantity)}</TableCell>
                  <TableCell className="num text-right">{money(row.salePrice)}</TableCell>
                  <TableCell className="num text-right text-muted-foreground">
                    {money(row.unitCost)}
                  </TableCell>
                  <TableCell className="num text-right">{money(row.revenue)}</TableCell>
                  <TableCell
                    className="num text-right font-medium"
                    style={{ color: row.profit < 0 ? "#d03b3b" : "#006300" }}
                  >
                    {money(row.profit)}
                  </TableCell>
                  <TableCell className="num text-right text-muted-foreground">
                    {row.marginPct == null ? "-" : `${row.marginPct.toFixed(1)}%`}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{row.areaName}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {row.shopName ?? "Direct sale"}
                  </TableCell>
                  <TableCell className="text-right">
                    <SoftDeleteButton
                      action={softDeleteSaleAction}
                      id={row.id}
                      title={`Remove sale #${row.id}`}
                      description={`${qty(row.quantity)} x ${row.sku} at ${money(row.salePrice)}. The ${qty(row.quantity)} unit(s) go back to batch #${row.batchId} and the sale is flagged as deleted, not erased.`}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Pagination
        page={list.page}
        pageCount={list.pageCount}
        total={list.total}
        pageSize={PAGE_SIZE}
        basePath="/sales"
        params={{ from: fromParam, to: toParam, area: areaParam, product: productParam }}
      />
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "gain" | "loss";
}) {
  return (
    <Card className="p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className="num mt-1.5 text-xl font-semibold"
        style={tone ? { color: tone === "loss" ? "#d03b3b" : "#006300" } : undefined}
      >
        {value}
      </p>
    </Card>
  );
}
