import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { FilterBarSkeleton } from "@/components/filter-bar-skeleton";
import { ListFilters, type FilterSpec } from "@/components/list-filters";
import { BookerManager } from "@/components/bookers/booker-manager";
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
import { dateOnly, money, qty } from "@/lib/format";
import { currentYear } from "@/lib/dates";
import { getBookerPerformance, getUncoveredAreas } from "@/lib/bookers";
import { getCashYears } from "@/lib/recognition";
import { prisma } from "@/lib/db";

export const metadata: Metadata = { title: "Bookers" };
export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
function parseId(value: string | undefined): number | null {
  if (!value || value === "all") return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Collecting is the job. Anything under 70% deserves a look. */
function rateTone(rate: number | null): "success" | "default" | "destructive" | "outline" {
  if (rate == null) return "outline";
  if (rate >= 90) return "success";
  if (rate >= 70) return "default";
  return "destructive";
}

export default async function BookersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const yearParam = parseId(first(sp.year));
  const areaParam = first(sp.area);

  const [years, areas] = await Promise.all([
    getCashYears(),
    prisma.area.findMany({
      where: { isDeleted: false },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  const year = yearParam && years.includes(yearParam) ? yearParam : (years[0] ?? currentYear());

  const [perf, uncovered, bookers] = await Promise.all([
    getBookerPerformance({ year, areaId: parseId(areaParam) }),
    getUncoveredAreas({ year }),
    prisma.booker.findMany({
      where: { isDeleted: false },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        code: true,
        phone: true,
        notes: true,
        isActive: true,
        _count: { select: { bookings: true } },
      },
    }),
  ]);

  const filters: FilterSpec[] = [
    {
      kind: "select",
      key: "year",
      label: "Year",
      value: String(year),
      allLabel: String(year),
      width: "w-[120px]",
      options: years.map((y) => ({ value: String(y), label: String(y) })),
    },
    {
      kind: "select",
      key: "area",
      label: "Area",
      value: areaParam ?? "all",
      allLabel: "All areas",
      width: "w-[180px]",
      options: areas.map((a) => ({ value: String(a.id), label: a.name })),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Bookers"
        description={`Who took which orders, and what came of them. Booking an order is the easy half - the columns that matter most are Collected and Overdue. Figures are for ${year}.`}
      />

      <Suspense
        fallback={
          <FilterBarSkeleton className="mb-4 h-[76px] animate-pulse rounded-lg border bg-card" />
        }
      >
        <ListFilters filters={filters} />
      </Suspense>

      <div className="mb-4 grid gap-4 sm:grid-cols-4">
        <Tile label="Bookings" value={qty(perf.totals.bookings)} />
        <Tile label="Booked value" value={money(perf.totals.bookedValue)} />
        <Tile label="Collected" value={money(perf.totals.collected)} tone="gain" />
        <Tile
          label="Outstanding"
          value={money(perf.totals.outstanding)}
          tone={perf.totals.outstanding > 0.005 ? "loss" : "gain"}
        />
      </div>

      {perf.totals.unattributed > 0.005 ? (
        <Alert tone="info" className="mb-4">
          <strong>{money(perf.totals.unattributed)}</strong> of bookings in {year} has no booker
          attached, so it is not counted against anyone below. Bookings taken before this page
          existed have no booker; pick one on new bookings and this shrinks to zero.
        </Alert>
      ) : null}

      {uncovered.length > 0 ? (
        <Alert tone="error" className="mb-4">
          <strong>No orders at all from {uncovered.length} area(s) in {year}:</strong>{" "}
          {uncovered.join(", ")}. Either nobody is covering them or they are no longer worth
          keeping.
        </Alert>
      ) : null}

      {/* ------------------------------------------------------ performance */}
      <Card className="mb-6 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Booker</TableHead>
              <TableHead className="text-right">Bookings</TableHead>
              <TableHead className="text-right">Booked value</TableHead>
              <TableHead className="text-right">Avg order</TableHead>
              <TableHead className="text-right">Collected</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead className="text-right">Outstanding</TableHead>
              <TableHead className="text-right">Overdue 30d+</TableHead>
              <TableHead className="text-right">Days to settle</TableHead>
              <TableHead className="text-right">Areas</TableHead>
              <TableHead className="text-right">Shops</TableHead>
              <TableHead className="text-right">Units</TableHead>
              <TableHead>Last order</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {perf.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={13} className="py-10 text-center text-muted-foreground">
                  No bookers yet. Add one below, then pick them on the{" "}
                  <Link href="/bookings/new" className="underline">
                    New Booking
                  </Link>{" "}
                  form.
                </TableCell>
              </TableRow>
            ) : (
              perf.rows.map((r) => (
                <TableRow key={r.id} className={r.isActive ? undefined : "opacity-60"}>
                  <TableCell className="whitespace-nowrap font-medium">
                    {r.name}
                    {r.code ? (
                      <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                        {r.code}
                      </span>
                    ) : null}
                    {!r.isActive ? (
                      <Badge variant="outline" className="ml-2">
                        Retired
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="num text-right">{qty(r.bookings)}</TableCell>
                  <TableCell className="num text-right font-medium">
                    {money(r.bookedValue)}
                  </TableCell>
                  <TableCell className="num text-right text-muted-foreground">
                    {r.avgOrderValue == null ? "—" : money(r.avgOrderValue)}
                  </TableCell>
                  <TableCell className="num text-right" style={{ color: "#006300" }}>
                    {money(r.collected)}
                  </TableCell>
                  <TableCell className="text-right">
                    {r.collectionRate == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <Badge variant={rateTone(r.collectionRate)}>
                        {r.collectionRate.toFixed(0)}%
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell
                    className="num text-right"
                    style={{ color: r.outstanding > 0.005 ? "#d03b3b" : undefined }}
                  >
                    {money(r.outstanding)}
                  </TableCell>
                  <TableCell
                    className="num text-right font-medium"
                    style={{ color: r.overdue > 0.005 ? "#d03b3b" : undefined }}
                  >
                    {money(r.overdue)}
                  </TableCell>
                  <TableCell className="num text-right text-muted-foreground">
                    {r.avgDaysToSettle == null ? "—" : `${r.avgDaysToSettle.toFixed(0)}d`}
                  </TableCell>
                  <TableCell className="num text-right">{r.areasCovered}</TableCell>
                  <TableCell className="num text-right">{r.shopsCovered}</TableCell>
                  <TableCell className="num text-right text-muted-foreground">
                    {qty(r.units)}
                  </TableCell>
                  <TableCell className="num whitespace-nowrap text-muted-foreground">
                    {r.lastBookingDate ? dateOnly(r.lastBookingDate) : "never"}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
          {perf.rows.length > 0 ? (
            <TableFooter>
              <TableRow>
                <TableCell className="text-xs uppercase tracking-wide">Total</TableCell>
                <TableCell className="num text-right">{qty(perf.totals.bookings)}</TableCell>
                <TableCell className="num text-right font-semibold">
                  {money(perf.totals.bookedValue)}
                </TableCell>
                <TableCell />
                <TableCell className="num text-right font-semibold" style={{ color: "#006300" }}>
                  {money(perf.totals.collected)}
                </TableCell>
                <TableCell />
                <TableCell className="num text-right font-semibold" style={{ color: "#d03b3b" }}>
                  {money(perf.totals.outstanding)}
                </TableCell>
                <TableCell colSpan={6} />
              </TableRow>
            </TableFooter>
          ) : null}
        </Table>
      </Card>

      <h2 className="mb-3 text-sm font-semibold">Manage bookers</h2>
      <BookerManager bookers={bookers.map((b) => ({ ...b, bookings: b._count.bookings }))} />
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
