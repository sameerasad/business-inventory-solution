"use client";

import * as React from "react";

import { money, qty } from "@/lib/format";

type Entry = {
  name?: string | number;
  dataKey?: string | number;
  value?: number | string;
  color?: string;
  payload?: Record<string, unknown>;
};

const LABELS: Record<string, string> = {
  revenue: "Revenue",
  profit: "Profit",
  units: "Units",
};

/**
 * Shared hover layer. Recharts hands us the hovered payload; we format money as
 * money and units as a count, and always show both revenue and profit for a
 * point even when only one of them is plotted, since that is the comparison the
 * user is actually making.
 */
export function ChartTooltip({
  active,
  payload,
  label,
  showUnits = true,
}: {
  active?: boolean;
  payload?: Entry[];
  label?: string | number;
  showUnits?: boolean;
}) {
  if (!active || !payload?.length) return null;

  const row = (payload[0]?.payload ?? {}) as Record<string, unknown>;
  const title = (row.label as string) ?? (label != null ? String(label) : "");

  const plotted = payload
    .map((entry) => {
      const key = String(entry.dataKey ?? entry.name ?? "");
      const value = typeof entry.value === "number" ? entry.value : Number(entry.value ?? 0);
      return { key, value, color: entry.color };
    })
    .filter((e) => e.key === "revenue" || e.key === "profit");

  const keys = new Set(plotted.map((p) => p.key));
  // Fill in the measure that is not plotted so the tooltip is the full picture.
  for (const key of ["revenue", "profit"] as const) {
    if (!keys.has(key) && typeof row[key] === "number") {
      plotted.push({ key, value: row[key] as number, color: undefined });
    }
  }

  const units = typeof row.units === "number" ? (row.units as number) : null;

  return (
    <div className="min-w-[9rem] rounded-md border bg-card p-2.5 text-xs shadow-md">
      {title ? <p className="mb-1.5 font-semibold text-foreground">{title}</p> : null}
      <dl className="space-y-1">
        {plotted.map((entry) => (
          <div key={entry.key} className="flex items-center justify-between gap-4">
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              {entry.color ? (
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-sm"
                  style={{ backgroundColor: entry.color }}
                />
              ) : (
                <span aria-hidden className="h-2 w-2 rounded-sm border border-border" />
              )}
              {LABELS[entry.key] ?? entry.key}
            </dt>
            <dd className="num font-medium text-foreground">{money(entry.value)}</dd>
          </div>
        ))}
        {showUnits && units != null ? (
          <div className="flex items-center justify-between gap-4 border-t pt-1">
            <dt className="text-muted-foreground">Units</dt>
            <dd className="num font-medium text-foreground">{qty(units)}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
