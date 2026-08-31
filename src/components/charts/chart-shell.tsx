import * as React from "react";

import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Every chart sits in the same frame: title, optional subtitle, optional control
 * in the top-right, fixed plot height, and a shared "nothing to show yet" state
 * so an empty database looks intentional rather than broken.
 */
export function ChartShell({
  title,
  description,
  action,
  isEmpty,
  emptyMessage = "No sales recorded for this selection yet.",
  height = 260,
  className,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  isEmpty?: boolean;
  emptyMessage?: string;
  height?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={className}>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </CardHeader>
      <CardContent>
        {isEmpty ? (
          <div
            className="flex items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground"
            style={{ height }}
          >
            {emptyMessage}
          </div>
        ) : (
          <div style={{ height }} className={cn("w-full")}>
            {children}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Legend swatch + label. Identity is never carried by colour alone. */
export function ChartLegend({
  items,
}: {
  items: { color: string; label: string; value?: string }[];
}) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden
            className="h-2.5 w-2.5 shrink-0 rounded-sm"
            style={{ backgroundColor: item.color }}
          />
          <span>{item.label}</span>
          {item.value ? <span className="num font-medium text-foreground">{item.value}</span> : null}
        </li>
      ))}
    </ul>
  );
}
