import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { PageHeader } from "@/components/page-header";
import { FilterBarSkeleton } from "@/components/filter-bar-skeleton";
import { DashboardFilters, PeriodToggle } from "@/components/dashboard/dashboard-filters";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { ChartLegend, ChartShell } from "@/components/charts/chart-shell";
import { BreakdownBar } from "@/components/charts/breakdown-bar";
import { CategoryDonut } from "@/components/charts/category-donut";
import { RevenueProfitBars } from "@/components/charts/revenue-profit-bars";
import { RevenueProfitTrend } from "@/components/charts/revenue-profit-trend";
import { CHART } from "@/components/charts/theme";
import { Alert } from "@/components/ui/alert";
import { money, MONTH_LABELS } from "@/lib/format";
import { currentMonthIndex0, currentYear, monthRange, yearRange } from "@/lib/dates";
import { getCategories } from "@/lib/queries";
import type { CashScope } from "@/lib/recognition";
import { getActiveBookers } from "@/lib/bookers";
import {
  getCashByArea,
  getCashByBooker,
  getCashByCategory,
  getCashByPackaging,
  getCashByProductName,
  getCashByShop,
  getCashByVariant,
  getCashKpis,
  getCashMonthlyTrend,
  getCashYears,
} from "@/lib/recognition";
import { prisma } from "@/lib/db";

export const metadata: Metadata = { title: "Dashboard" };

// Aggregates are cheap and always want to be current after a sale is recorded.
export const dynamic = "force-dynamic";

const JUICE_CATEGORY_NAME = "Juice & Beverage";

function parseId(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || raw === "all") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  const [years, categories, areaRows, bookerRows] = await Promise.all([
    getCashYears(),
    getCategories(),
    prisma.area.findMany({
      where: { isDeleted: false },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    // Retired bookers stay selectable here: last year's figures are still
    // theirs, and hiding them would make a past year unexplainable.
    prisma.booker.findMany({
      where: { isDeleted: false },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
  ]);

  const yearParam = parseId(sp.year);
  const year = yearParam && years.includes(yearParam) ? yearParam : (years[0] ?? currentYear());
  const categoryId = parseId(sp.category);
  const areaId = parseId(sp.area);
  const bookerId = parseId(sp.booker);
  const period: "year" | "month" = sp.period === "month" ? "month" : "year";

  const filters = { year, categoryId, areaId, bookerId };
  const yearScope: CashScope = {
    ...yearRange(year),
    categoryId,
    areaId,
    bookerId,
  };

  // The area / shop charts can be narrowed to a single month. For a past year
  // "this month" is meaningless, so that toggle uses December of that year.
  const monthIndex0 = year === currentYear() ? currentMonthIndex0() : 11;
  const geoScope: CashScope =
    period === "month"
      ? { ...monthRange(year, monthIndex0), categoryId, areaId, bookerId }
      : yearScope;
  const geoLabel = period === "month" ? `${MONTH_LABELS[monthIndex0]} ${year}` : String(year);

  // The flavor chart is about the juice line. With no explicit category filter we
  // scope it to Juice & Beverage so chocolate does not crowd the five flavors;
  // an explicit filter always wins.
  const juiceCategoryId = categories.find((c) => c.name === JUICE_CATEGORY_NAME)?.id ?? null;
  const flavorCategoryId = categoryId ?? juiceCategoryId;
  const flavorScope: CashScope = { ...yearScope, categoryId: flavorCategoryId };
  const flavorCategoryName =
    categories.find((c) => c.id === flavorCategoryId)?.name ?? "all categories";

  const [kpis, trend, packaging, variants, flavors, byArea, byShop, byCategory, byBooker] =
    await Promise.all([
      getCashKpis(filters),
      getCashMonthlyTrend(filters),
      getCashByPackaging(yearScope),
      getCashByVariant(yearScope),
      getCashByProductName(flavorScope),
      getCashByArea(geoScope),
      getCashByShop(geoScope, 10),
      getCashByCategory(yearScope),
      // Unfiltered by booker on purpose: a chart comparing bookers is useless
      // when narrowed to one, so it always shows the whole field.
      getCashByBooker({ ...yearScope, bookerId: null }),
    ]);

  const hasAnyData = kpis.year.revenue > 0 || trend.some((m) => m.revenue > 0);
  const isFiltered = categoryId != null || areaId != null || bookerId != null;
  const selectedAreaName = areaRows.find((a) => a.id === areaId)?.name ?? null;
  const selectedBookerName = bookerRows.find((b) => b.id === bookerId)?.name ?? null;
  const trendLegend = [
    { color: CHART.revenue, label: "Revenue" },
    { color: CHART.profit, label: "Profit" },
  ];

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description={`Revenue and profit for ${year}${
          selectedAreaName ? ` in ${selectedAreaName}` : ""
        }${selectedBookerName ? `, booked by ${selectedBookerName}` : ""}, counted when the money arrives. A delivered order counts only once it is paid - partly paid orders count in proportion, dated by the payment. Units are what physically went out.`}
      />

      <Suspense fallback={<FilterBarSkeleton />}>
        <DashboardFilters
          years={years}
          categories={categories}
          areas={areaRows}
          bookers={bookerRows}
          selected={{ year, categoryId, areaId, bookerId }}
        />
      </Suspense>

      {!hasAnyData ? (
        <Alert tone="info" className="mb-5">
          {/* With a filter on, "nothing received" is almost always the filter
              rather than the business, and saying so saves a wild goose chase. */}
          {isFiltered ? (
            <>
              Nothing was received in {year} matching these filters. Clear them to see the whole
              picture.
            </>
          ) : (
            <>
              No money received in {year} yet. Bookings count once they are paid - record a payment
              on the <strong>Bookings</strong> page - and a counter sale on{" "}
              <strong>New Sale</strong> counts straight away.
            </>
          )}
        </Alert>
      ) : null}

      {/* ---------------------------------------------------------- KPI cards */}
      {kpis.awaitingPayment > 0.005 ? (
        <Alert tone="info" className="mb-5">
          <strong>{money(kpis.awaitingPayment)}</strong> of delivered goods has not been paid for
          yet, so it is not counted below.{" "}
          <Link href="/receivables" className="font-medium underline">
            See receivables
          </Link>
        </Alert>
      ) : null}

      <section aria-label="Headline figures" className="mb-5 grid gap-4 md:grid-cols-3">
        <KpiCard
          label="Today"
          sublabel={kpis.isCurrentYear ? undefined : "current year only"}
          data={kpis.today}
          muted={!kpis.isCurrentYear}
        />
        <KpiCard label="This Month" sublabel={kpis.monthLabel} data={kpis.month} />
        <KpiCard label="This Year" sublabel={String(year)} data={kpis.year} />
      </section>

      {/* ------------------------------------------------------------- charts */}
      <div className="grid gap-4">
        <ChartShell
          title="Monthly revenue & profit"
          description={`All 12 months of ${year}. Both series share one axis, so the gap between the profit line and the top of each bar is the cost.`}
          action={<ChartLegend items={trendLegend} />}
          height={300}
          isEmpty={!hasAnyData}
        >
          <RevenueProfitTrend data={trend} />
        </ChartShell>

        <div className="grid gap-4 lg:grid-cols-2">
          <ChartShell
            title="Revenue by packaging type"
            description={`Bottle vs Tetra Pack vs Bar, ${year}.`}
            isEmpty={packaging.length === 0}
          >
            <BreakdownBar data={packaging} orientation="horizontal" labelWidth={96} />
          </ChartShell>

          <ChartShell
            title="Revenue by volume size"
            description={`Ordered smallest to largest, ${year}.`}
            isEmpty={variants.length === 0}
          >
            <BreakdownBar data={variants} orientation="vertical" />
          </ChartShell>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <ChartShell
            title="Revenue by flavor"
            description={`${flavorCategoryName}, ${year}.`}
            isEmpty={flavors.length === 0}
            height={280}
          >
            <BreakdownBar data={flavors} orientation="horizontal" labelWidth={128} />
          </ChartShell>

          <ChartShell
            title="Category split"
            description={`Share of revenue, ${year}.`}
            isEmpty={byCategory.length === 0}
            height={280}
          >
            <CategoryDonut data={byCategory} />
          </ChartShell>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <ChartShell
            title="Revenue & profit by area"
            description={geoLabel}
            action={
              <div className="flex flex-col items-end gap-2">
                <Suspense fallback={<FilterBarSkeleton className="h-7 w-[104px] rounded-md border" />}>
                  <PeriodToggle value={period} />
                </Suspense>
                <ChartLegend items={trendLegend} />
              </div>
            }
            isEmpty={byArea.length === 0}
            height={290}
          >
            <RevenueProfitBars data={byArea} labelWidth={112} />
          </ChartShell>

          <ChartShell
            title="Revenue &amp; profit by booker"
            description={`Whose orders the money came from, ${year}. Counted when it was paid, so a booker who sells hard and collects slowly sits lower here than on the Bookers page.`}
            action={<ChartLegend items={trendLegend} />}
            isEmpty={byBooker.length === 0}
            height={290}
          >
            <RevenueProfitBars data={byBooker} labelWidth={128} />
          </ChartShell>

          <ChartShell
            title={selectedAreaName ? `Top shops in ${selectedAreaName}` : "Top shops"}
            description={`Highest revenue first, ${geoLabel}. Direct sales with no shop are shown as their own row.`}
            isEmpty={byShop.length === 0}
            height={290}
          >
            <BreakdownBar data={byShop} orientation="horizontal" labelWidth={140} />
          </ChartShell>
        </div>
      </div>
    </div>
  );
}
