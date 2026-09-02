"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { moneyCompact } from "@/lib/format";
import { ChartTooltip } from "@/components/charts/chart-tooltip";
import { AXIS_LINE, AXIS_TICK, CHART, MARGIN, RADIUS_VERTICAL } from "@/components/charts/theme";

/** Anything with a label plus the two money series. */
export type TrendPoint = { label: string; revenue: number; profit: number };

/**
 * Dashboard chart 1 - monthly revenue (bars) against profit (line).
 *
 * Both measures are money, so they share ONE y-axis. That is the whole point:
 * the gap between the line and the top of each bar is the cost, read directly.
 * A second axis would let the two series be scaled independently and would make
 * that gap meaningless.
 */
export function RevenueProfitTrend({ data }: { data: TrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={MARGIN} barCategoryGap="22%">
        <CartesianGrid stroke={CHART.grid} strokeDasharray="0" vertical={false} />
        <XAxis
          dataKey="label"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={AXIS_LINE}
          interval={0}
          minTickGap={0}
        />
        <YAxis
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          width={58}
          tickFormatter={(v: number) => moneyCompact(v)}
        />
        <Tooltip
          content={<ChartTooltip />}
          cursor={{ fill: "rgba(11,11,11,0.04)" }}
        />
        <Bar
          dataKey="revenue"
          name="Revenue"
          fill={CHART.revenue}
          radius={RADIUS_VERTICAL}
          maxBarSize={34}
        />
        <Line
          type="monotone"
          dataKey="profit"
          name="Profit"
          stroke={CHART.profit}
          strokeWidth={2}
          dot={{ r: 3, fill: CHART.profit, stroke: CHART.surface, strokeWidth: 2 }}
          activeDot={{ r: 5, fill: CHART.profit, stroke: CHART.surface, strokeWidth: 2 }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
