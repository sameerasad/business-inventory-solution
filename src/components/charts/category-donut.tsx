"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import type { Breakdown } from "@/lib/queries";
import { money, percent } from "@/lib/format";
import { CATEGORY_COLORS, CHART } from "@/components/charts/theme";

/**
 * Dashboard chart 6 - the category share of revenue.
 *
 * A donut is only defensible for a couple of slices summing to a meaningful
 * whole, which is exactly the case here (Juice & Beverage vs Chocolate). The
 * total sits in the hole so the reader gets the absolute figure as well as the
 * share, and every slice is labelled beside the chart - the ring alone never has
 * to carry identity.
 */
export function CategoryDonut({ data }: { data: Breakdown[] }) {
  const total = data.reduce((sum, d) => sum + d.revenue, 0);

  return (
    <div className="flex h-full flex-col items-center gap-3 sm:flex-row">
      <div className="relative h-full min-h-[168px] w-full sm:w-[52%]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip content={<DonutTooltip total={total} />} />
            <Pie
              data={data}
              dataKey="revenue"
              nameKey="label"
              innerRadius="62%"
              outerRadius="92%"
              paddingAngle={2}
              startAngle={90}
              endAngle={-270}
              stroke={CHART.surface}
              strokeWidth={2}
            >
              {data.map((entry, i) => (
                <Cell key={entry.key} fill={CATEGORY_COLORS[i % CATEGORY_COLORS.length]} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Total</span>
          <span className="num text-base font-semibold">{money(total)}</span>
        </div>
      </div>

      <ul className="w-full space-y-2 sm:w-[48%]">
        {data.map((entry, i) => (
          <li key={entry.key} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }}
              />
              <span className="truncate text-muted-foreground">{entry.label}</span>
            </span>
            <span className="shrink-0 text-right">
              <span className="num font-medium">{money(entry.revenue)}</span>
              <span className="num ml-2 text-xs text-muted-foreground">
                {percent(entry.revenue, total)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DonutTooltip({
  active,
  payload,
  total,
}: {
  active?: boolean;
  payload?: { payload?: Breakdown }[];
  total: number;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="rounded-md border bg-card p-2.5 text-xs shadow-md">
      <p className="mb-1 font-semibold">{row.label}</p>
      <div className="flex items-center justify-between gap-4">
        <span className="text-muted-foreground">Revenue</span>
        <span className="num font-medium">{money(row.revenue)}</span>
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-muted-foreground">Profit</span>
        <span className="num font-medium">{money(row.profit)}</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-4 border-t pt-1">
        <span className="text-muted-foreground">Share</span>
        <span className="num font-medium">{percent(row.revenue, total)}</span>
      </div>
    </div>
  );
}
