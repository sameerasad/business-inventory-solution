import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { FilterBarSkeleton } from "@/components/filter-bar-skeleton";
import { ListFilters, type FilterSpec } from "@/components/list-filters";
import { PaymentDialog } from "@/components/bookings/payment-dialog";
import { WhatsAppShareDialog } from "@/components/bookings/whatsapp-share-dialog";
import { Alert } from "@/components/ui/alert";
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
import { dateOnly, money } from "@/lib/format";
import { getReceivables } from "@/lib/bookings";
import { prisma } from "@/lib/db";

export const metadata: Metadata = { title: "Receivables" };
export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Older debt is the debt worth chasing, so it gets the louder colour. */
function ageTone(days: number): "outline" | "default" | "destructive" {
  if (days <= 7) return "outline";
  if (days <= 30) return "default";
  return "destructive";
}

export default async function ReceivablesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const areaParam = first(sp.area);
  const areaId = areaParam && areaParam !== "all" ? Number.parseInt(areaParam, 10) : null;

  const [areas, data] = await Promise.all([
    prisma.area.findMany({
      where: { isDeleted: false },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    getReceivables({ areaId: Number.isInteger(areaId) && areaId! > 0 ? areaId : null }),
  ]);

  const filters: FilterSpec[] = [
    {
      kind: "select",
      key: "area",
      label: "Area",
      value: areaParam ?? "all",
      allLabel: "All areas",
      width: "w-[200px]",
      options: areas.map((a) => ({ value: String(a.id), label: a.name })),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Receivables"
        description="Money owed on delivered orders, oldest first. The goods have gone out and the revenue is already counted - this is only the cash still to arrive."
      />

      <Suspense
        fallback={
          <FilterBarSkeleton className="mb-4 h-[76px] animate-pulse rounded-lg border bg-card" />
        }
      >
        <ListFilters filters={filters} />
      </Suspense>

      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <Tile label="Invoiced" value={money(data.totals.invoiced)} />
        <Tile label="Collected" value={money(data.totals.collected)} tone="gain" />
        <Tile
          label="Outstanding"
          value={money(data.totals.outstanding)}
          tone={data.totals.outstanding > 0.005 ? "loss" : "gain"}
        />
      </div>

      {/* Aging: the same money, sliced by how long it has been owed. */}
      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        {data.buckets.map((b) => (
          <Card key={b.label} className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {b.label}
            </p>
            <p className="num mt-1 text-lg font-semibold">{money(b.amount)}</p>
            <p className="text-xs text-muted-foreground">
              {b.count} invoice{b.count === 1 ? "" : "s"}
            </p>
          </Card>
        ))}
      </div>

      {data.rows.length === 0 ? (
        <Alert tone="success">
          Nothing outstanding — every delivered order is fully paid.{" "}
          <Link href="/bookings" className="font-medium underline">
            View bookings
          </Link>
        </Alert>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Age</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Area</TableHead>
                <TableHead>Shop</TableHead>
                <TableHead className="text-right">Invoice total</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap font-mono text-xs font-medium">
                    {row.invoiceNo}
                  </TableCell>
                  <TableCell className="num whitespace-nowrap">
                    {dateOnly(row.bookingDate)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={ageTone(row.daysOutstanding)}>
                      {row.daysOutstanding}d
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-medium">
                    {row.customerName ?? (
                      <span className="font-normal text-muted-foreground">Walk-in customer</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{row.areaName}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {row.shopName ?? "Direct sale"}
                  </TableCell>
                  <TableCell className="num text-right">{money(row.total)}</TableCell>
                  <TableCell className="num text-right" style={{ color: "#006300" }}>
                    {money(row.paid)}
                  </TableCell>
                  <TableCell className="num text-right font-semibold" style={{ color: "#d03b3b" }}>
                    {money(row.balance)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <PaymentDialog
                        bookingId={row.id}
                        invoiceNo={row.invoiceNo}
                        total={row.total}
                        paid={row.paid}
                      />
                      <WhatsAppShareDialog
                        bookingId={row.id}
                        invoiceNo={row.invoiceNo}
                        customerPhone={row.customerPhone}
                        shopPhone={row.shopPhone}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={8} className="text-xs uppercase tracking-wide">
                  Total outstanding
                </TableCell>
                <TableCell className="num text-right font-semibold" style={{ color: "#d03b3b" }}>
                  {money(data.totals.outstanding)}
                </TableCell>
                <TableCell />
              </TableRow>
            </TableFooter>
          </Table>
        </Card>
      )}
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
