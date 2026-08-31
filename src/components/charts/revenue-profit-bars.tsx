"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { Breakdown } from "@/lib/queries";
import { moneyCompact } from "@/lib/format";
import { ChartTooltip } from "@/components/charts/chart-tooltip";
import { AXIS_LINE, AXIS_TICK, CHART, MARGIN, RADIUS_HORIZONTAL } from "@/components/charts/theme";

/**
 * Dashboard chart 5 - revenue AND profit per bucket, side by side.
 *
 * Two money series on one shared axis, so bar lengths are directly comparable
 * and the profit bar visibly sits inside the revenue bar. The 2px barGap keeps a
 * surface-coloured sliver between the paired fills.
 */
export function RevenueProfitBars({
  data,
  labelWidth = 108,
}: {
  data: Breakdown[];
  labelWidth?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={data}
        layout="vertical"
        margin={MARGIN}
        barGap={2}
        barCategoryGap="26%"
      >
        <CartesianGrid stroke={CHART.grid} horizontal={false} />
        <XAxis
          type="number"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => moneyCompact(v)}
        />
        <YAxis
          type="category"
          dataKey="label"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={AXIS_LINE}
          width={labelWidth}
          interval={0}
        />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(11,11,11,0.04)" }} />
        <Bar
          dataKey="revenue"
          name="Revenue"
          fill={CHART.revenue}
          radius={RADIUS_HORIZONTAL}
          maxBarSize={14}
        />
        <Bar
          dataKey="profit"
          name="Profit"
          fill={CHART.profit}
          radius={RADIUS_HORIZONTAL}
          maxBarSize={14}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
