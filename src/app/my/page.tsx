import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { PageHeader } from "@/components/page-header";
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
import { cn } from "@/lib/utils";
import { MONTH_LABELS, dateOnly, money, qty } from "@/lib/format";
import { currentMonthIndex0, currentYear } from "@/lib/dates";
import { getMyBookings, getMyMonth, getMyTarget } from "@/lib/my";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/db";

export const metadata: Metadata = { title: "My Target" };
export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The month asked for, or this one. */
function readMonth(sp: Record<string, string | string[] | undefined>): {
  year: number;
  month0: number;
} {
  const y = Number.parseInt(first(sp.y) ?? "", 10);
  const m = Number.parseInt(first(sp.m) ?? "", 10);
  const okYear = Number.isInteger(y) && y >= 2000 && y <= 2100;
  const okMonth = Number.isInteger(m) && m >= 1 && m <= 12;
  return okYear && okMonth
    ? { year: y, month0: m - 1 }
    : { year: currentYear(), month0: currentMonthIndex0() };
}

function step(year: number, month0: number, by: number): string {
  const d = new Date(Date.UTC(year, month0 + by, 1));
  return `/my?y=${d.getUTCFullYear()}&m=${d.getUTCMonth() + 1}`;
}

export default async function MyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const { year, month0 } = readMonth(sp);
  const label = `${MONTH_LABELS[month0]} ${year}`;

  // An admin who has not made themselves a booker has no "mine" to show. Said
  // plainly rather than rendered as a month of zeroes, which reads as a bad
  // month rather than as a page that does not apply.
  if (user.bookerId == null) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="My target" description="Your own bookings, collections and target." />
        <Alert tone="info">
          This account is not linked to a booker yet, so it has no orders of its own to show.
          {user.role === "admin" ? (
            <>
              {" "}
              Link it on the{" "}
              <Link href="/users" className="font-medium underline">
                Users
              </Link>{" "}
              page to see your own figures here as well as the whole business.
            </>
          ) : (
            " Ask the owner to link it."
          )}
        </Alert>
      </div>
    );
  }

  const bookerId = user.bookerId;
  const [booker, month, target, bookings] = await Promise.all([
    prisma.booker.findUnique({ where: { id: bookerId }, select: { name: true } }),
    getMyMonth(bookerId, year, month0),
    getMyTarget(bookerId, year, month0),
    getMyBookings(bookerId, year, month0),
  ]);

  return (
    <div>
      <PageHeader
        title="My target"
        description={`${booker?.name ?? "You"} - orders taken in ${label}, and what has been collected against them.`}
        action={
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="icon" asChild title="Previous month">
              <Link href={step(year, month0, -1)}>
                <ChevronLeft className="h-4 w-4" />
                <span className="sr-only">Previous month</span>
              </Link>
            </Button>
            <span className="min-w-[9rem] text-center text-sm font-medium">{label}</span>
            <Button variant="outline" size="icon" asChild title="Next month">
              <Link href={step(year, month0, 1)}>
                <ChevronRight className="h-4 w-4" />
                <span className="sr-only">Next month</span>
              </Link>
            </Button>
          </div>
        }
      />

      {target == null ? (
        <Alert tone="info" className="mb-4">
          No target has been set for {label}. The figures below are still yours; there is just
          nothing to measure them against yet.
        </Alert>
      ) : null}

      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <Progress
          label="Booked value"
          done={month.booked}
          goal={target?.amount ?? null}
          format={money}
        />
        <Progress label="Packs sold" done={month.packs} goal={target?.packs ?? null} format={qty} />
      </div>

      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Orders" value={qty(month.orders)} />
        <Tile label="Collected" value={money(month.collected)} tone="gain" />
        <Tile
          label="Outstanding"
          value={money(month.outstanding)}
          tone={month.outstanding > 0.005 ? "loss" : undefined}
        />
        <Tile label="Shops / areas" value={`${qty(month.shops)} / ${qty(month.areas)}`} />
      </div>

      {target?.notes ? (
        <Alert tone="info" className="mb-4">
          {target.notes}
        </Alert>
      ) : null}

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Invoice</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Shop</TableHead>
              <TableHead>Area</TableHead>
              <TableHead className="text-right">Packs</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead className="text-right">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bookings.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                  No orders in {label}.{" "}
                  <Link href="/bookings/new" className="underline">
                    Take a booking
                  </Link>
                  .
                </TableCell>
              </TableRow>
            ) : (
              bookings.map((row) => (
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
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {row.shopName ?? "Direct sale"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{row.areaName}</TableCell>
                  <TableCell className="num text-right">{qty(row.packs)}</TableCell>
                  <TableCell className="num text-right font-medium">{money(row.total)}</TableCell>
                  <TableCell className="num text-right" style={{ color: "#006300" }}>
                    {money(row.paid)}
                  </TableCell>
                  <TableCell
                    className="num text-right font-medium"
                    style={{ color: row.balance > 0.005 ? "#d03b3b" : undefined }}
                  >
                    {money(row.balance)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

/**
 * How far along the month is against the target.
 *
 * The bar stops at full but the percentage does not: a booker who has done
 * 140% should read 140%, and a bar that silently caps would make a very good
 * month look exactly like a just-met one.
 */
function Progress({
  label,
  done,
  goal,
  format,
}: {
  label: string;
  done: number;
  goal: number | null;
  format: (n: number) => string;
}) {
  const pct = goal && goal > 0 ? (done / goal) * 100 : null;

  return (
    <Card className="p-5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        {pct == null ? (
          <p className="text-xs text-muted-foreground">No target</p>
        ) : (
          <p className="num text-xs font-medium">{Math.round(pct)}%</p>
        )}
      </div>

      <p className="num mt-1.5 text-xl font-semibold">
        {format(done)}
        {goal != null ? (
          <span className="text-sm font-normal text-muted-foreground"> of {format(goal)}</span>
        ) : null}
      </p>

      {pct != null ? (
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full", pct >= 100 ? "bg-emerald-600" : "bg-primary")}
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        </div>
      ) : null}
    </Card>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "gain" | "loss" }) {
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
