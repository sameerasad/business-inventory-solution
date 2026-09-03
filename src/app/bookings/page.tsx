import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { Download } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { FilterBarSkeleton } from "@/components/filter-bar-skeleton";
import { ListFilters, type FilterSpec } from "@/components/list-filters";
import { Pagination } from "@/components/pagination";
import { SoftDeleteButton } from "@/components/forms/soft-delete-button";
import { WhatsAppShareDialog } from "@/components/bookings/whatsapp-share-dialog";
import { PaymentDialog, PaymentStatusBadge } from "@/components/bookings/payment-dialog";
import { softDeleteBookingAction } from "@/actions/bookings";
import { EditBookingDialog } from "@/components/bookings/edit-booking-dialog";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { dateOnly, money, qty } from "@/lib/format";
import { isDateOnly } from "@/lib/dates";
import { BOOKINGS_PAGE_SIZE, getBookingList } from "@/lib/bookings";
import { prisma } from "@/lib/db";
import { getAreasWithShops } from "@/lib/queries";

export const metadata: Metadata = { title: "Bookings" };
export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseId(value: string | undefined): number | null {
  if (!value || value === "all") return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const fromParam = first(sp.from);
  const toParam = first(sp.to);
  const areaParam = first(sp.area);
  const bookerParam = first(sp.booker);
  const pageParam = Number.parseInt(first(sp.page) ?? "1", 10);

  const from = fromParam && isDateOnly(fromParam) ? fromParam : null;
  const to = toParam && isDateOnly(toParam) ? toParam : null;
  const invalidRange = from != null && to != null && from > to;

  const [areas, bookers, areasWithShops, list] = await Promise.all([
    prisma.area.findMany({
      where: { isDeleted: false },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.booker.findMany({
      where: { isDeleted: false },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    getAreasWithShops(),
    getBookingList({
      from: invalidRange ? null : from,
      to: invalidRange ? null : to,
      areaId: parseId(areaParam),
      bookerId: parseId(bookerParam),
      q: null,
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
      key: "booker",
      label: "Booker",
      value: bookerParam ?? "all",
      allLabel: "All bookers",
      width: "w-[180px]",
      options: bookers.map((b) => ({ value: String(b.id), label: b.name })),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Bookings"
        description="Orders taken by a booker. Each one recorded its own sales and drew stock down automatically, so these figures are the same ones the dashboard uses."
        action={
          <Button asChild>
            <Link href="/bookings/new">New booking</Link>
          </Button>
        }
      />

      <Suspense
        fallback={
          <FilterBarSkeleton className="mb-4 h-[76px] animate-pulse rounded-lg border bg-card" />
        }
      >
        <ListFilters filters={filters} />
      </Suspense>

      {invalidRange ? (
        <Alert tone="error" className="mb-4">
          The From date is after the To date, so the date filter was ignored.
        </Alert>
      ) : null}

      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <Tile label="Booked value (filtered)" value={money(list.totals.revenue)} />
        <Tile
          label="Profit (filtered)"
          value={money(list.totals.profit)}
          tone={list.totals.profit < 0 ? "loss" : "gain"}
        />
        <Tile label="Collected (filtered)" value={money(list.totals.collected)} tone="gain" />
      </div>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Invoice</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Area</TableHead>
              <TableHead>Shop</TableHead>
              <TableHead className="text-right">Lines</TableHead>
              <TableHead className="text-right">Units</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Profit</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Booker</TableHead>
              <TableHead className="text-right">Invoice</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={16} className="py-10 text-center text-muted-foreground">
                  No bookings match these filters.{" "}
                  <Link href="/bookings/new" className="underline">
                    Take a booking
                  </Link>
                  .
                </TableCell>
              </TableRow>
            ) : (
              list.rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap font-mono text-xs font-medium">
                    {row.invoiceNo}
                  </TableCell>
                  <TableCell className="num whitespace-nowrap">
                    {dateOnly(row.bookingDate)}
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
                  <TableCell className="num text-right text-muted-foreground">
                    {row.lineCount}
                  </TableCell>
                  <TableCell className="num text-right">{qty(row.units)}</TableCell>
                  <TableCell className="num text-right font-medium">{money(row.total)}</TableCell>
                  <TableCell
                    className="num text-right font-medium"
                    style={{ color: row.profit < 0 ? "#d03b3b" : "#006300" }}
                  >
                    {money(row.profit)}
                  </TableCell>
                  <TableCell className="num text-right" style={{ color: "#006300" }}>
                    {money(row.paid)}
                  </TableCell>
                  <TableCell
                    className="num text-right font-medium"
                    style={{ color: row.balance > 0.005 ? "#d03b3b" : undefined }}
                  >
                    {money(row.balance)}
                  </TableCell>
                  <TableCell>
                    <PaymentStatusBadge total={row.total} paid={row.paid} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {row.bookerName ?? (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {/* A plain link, so the browser downloads it straight from
                          the route handler with no client-side JS involved. */}
                      <a
                        href={`/api/invoices/${row.id}`}
                        className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                      >
                        <Download className="h-3.5 w-3.5" />
                        PDF
                      </a>
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
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-0.5">
                    <EditBookingDialog
                      booking={{
                        id: row.id,
                        invoiceNo: row.invoiceNo,
                        customerName: row.customerName,
                        customerPhone: row.customerPhone,
                        areaId: row.areaId,
                        shopId: row.shopId,
                        bookerId: row.bookerId,
                        bookingDate: dateOnly(row.bookingDate),
                        notes: row.notes,
                      }}
                      areas={areasWithShops}
                      bookers={bookers}
                    />
                    <SoftDeleteButton
                      action={softDeleteBookingAction}
                      id={row.id}
                      title={`Cancel ${row.invoiceNo}`}
                      description={`${row.customerName ?? "Walk-in customer"}, ${qty(row.units)} unit(s), ${money(row.total)}. All ${row.units} unit(s) go back to the batches they came from and the sales stop counting. The booking is kept so the invoice number is never reused.`}
                      confirmLabel="Cancel booking"
                    />
                    </div>
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
        pageSize={BOOKINGS_PAGE_SIZE}
        basePath="/bookings"
        params={{ from: fromParam, to: toParam, area: areaParam }}
      />

      <p className="mt-4 text-xs text-muted-foreground">
        Cancelled bookings are hidden here but keep their invoice number. The PDF for a cancelled
        booking is watermarked <Badge variant="destructive">CANCELLED</Badge>.
      </p>
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
