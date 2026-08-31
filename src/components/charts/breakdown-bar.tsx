"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { Breakdown } from "@/lib/queries";
import { money, moneyCompact } from "@/lib/format";
import { ChartTooltip } from "@/components/charts/chart-tooltip";
import {
  AXIS_LINE,
  AXIS_TICK,
  CHART,
  MARGIN,
  RADIUS_HORIZONTAL,
  RADIUS_VERTICAL,
} from "@/components/charts/theme";

/**
 * Dashboard charts 2, 3 and 4 - one measure across a handful of named buckets
 * (packaging type, volume, flavor, shop).
 *
 * Deliberately a SINGLE colour: there is one series, so a colour per bar would
 * encode nothing that the bar length does not already say, and it would burn
 * five palette slots that the reader then has to map back through a legend.
 * Values are labelled directly on the bars, which doubles as the contrast relief
 * for the muted palette.
 *
 * "horizontal" (bars running left-to-right) is the default because the category
 * names are words - they read straight instead of being rotated 45 degrees.
 * Use "vertical" for ordered numeric buckets like volume, where left-to-right
 * order is itself the message.
 */
export function BreakdownBar({
  data,
  orientation = "horizontal",
  labelWidth = 108,
}: {
  data: Breakdown[];
  orientation?: "horizontal" | "vertical";
  labelWidth?: number;
}) {
  if (orientation === "vertical") {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={MARGIN} barCategoryGap="28%">
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={AXIS_LINE} interval={0} />
          <YAxis
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={58}
            tickFormatter={(v: number) => moneyCompact(v)}
          />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(11,11,11,0.04)" }} />
          <Bar dataKey="revenue" name="Revenue" fill={CHART.single} radius={RADIUS_VERTICAL} maxBarSize={56}>
            <LabelList
              dataKey="revenue"
              position="top"
              formatter={(v: number) => moneyCompact(v)}
              style={{ fill: CHART.inkSecondary, fontSize: 11, fontWeight: 500 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={data}
        layout="vertical"
        margin={{ ...MARGIN, right: 64 }}
        barCategoryGap="24%"
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
          fill={CHART.single}
          radius={RADIUS_HORIZONTAL}
          maxBarSize={26}
        >
          <LabelList
            dataKey="revenue"
            position="right"
            formatter={(v: number) => money(v)}
            style={{ fill: CHART.inkSecondary, fontSize: 11, fontWeight: 500 }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
