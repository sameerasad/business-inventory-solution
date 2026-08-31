import { Card, CardContent } from "@/components/ui/card";
import { money, qty } from "@/lib/format";
import type { Money } from "@/lib/queries";

/**
 * The three headline cards. Revenue is the hero figure; profit sits directly
 * beneath it with its margin, because revenue on its own is the number that
 * flatters and misleads.
 */
export function KpiCard({
  label,
  sublabel,
  data,
  muted,
}: {
  label: string;
  sublabel?: string;
  data: Money;
  muted?: boolean;
}) {
  const margin = data.revenue > 0 ? (data.profit / data.revenue) * 100 : null;

  return (
    <Card className={muted ? "opacity-70" : undefined}>
      <CardContent className="p-5">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          {sublabel ? (
            <p className="text-[11px] text-muted-foreground">{sublabel}</p>
          ) : null}
        </div>

        <p className="mt-2 text-2xl font-semibold tracking-tight">{money(data.revenue)}</p>
        <p className="text-xs text-muted-foreground">Revenue</p>

        <div className="mt-3 flex items-baseline justify-between gap-2 border-t pt-3">
          <div>
            {/* Selling below cost is possible, so a loss must not be painted green. */}
            <p
              className="num text-base font-semibold"
              style={{ color: data.profit < 0 ? "#d03b3b" : "#006300" }}
            >
              {money(data.profit)}
            </p>
            <p className="text-xs text-muted-foreground">Profit</p>
          </div>
          <div className="text-right">
            <p className="num text-sm font-medium">
              {margin == null ? "-" : `${margin.toFixed(1)}%`}
            </p>
            <p className="text-xs text-muted-foreground">Margin</p>
          </div>
          <div className="text-right">
            <p className="num text-sm font-medium">{qty(data.units)}</p>
            <p className="text-xs text-muted-foreground">Units</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
