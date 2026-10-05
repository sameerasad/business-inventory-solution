import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { qty } from "@/lib/format";
import type { StockCoverRow } from "@/lib/queries";

/** Below this many days of stock left, it needs ordering now. */
const URGENT = 7;
/** Below this, it needs ordering before the week is out. */
const SOON = 14;

function coverTone(days: number | null): "outline" | "default" | "destructive" | "success" {
  if (days == null) return "outline";
  if (days < URGENT) return "destructive";
  if (days < SOON) return "default";
  return "success";
}

function coverLabel(row: StockCoverRow): string {
  if (row.daysOfCover == null) return row.currentStock > 0 ? "not selling" : "none, no sales";
  if (row.currentStock === 0) return "out of stock";
  return `${Math.floor(row.daysOfCover)} days`;
}

/**
 * How long what is on the shelf will last at the rate it is leaving.
 *
 * The stock table already says how many are left. The number that decides
 * anything is how many DAYS that is, because two hundred units is a lot of one
 * line and a day and a half of another.
 *
 * No reorder quantity is suggested. How much to buy depends on when the
 * supplier next comes, the minimum order, and what cash is free - none of which
 * is in this database. The rate and the cover are what it can honestly say.
 */
export function StockCoverTable({
  rows,
  dataDays,
  limit = 12,
}: {
  rows: StockCoverRow[];
  /** How many days of sales history this is actually built on. */
  dataDays: number;
  limit?: number;
}) {
  const shown = rows.slice(0, limit);
  const urgent = rows.filter((r) => r.daysOfCover != null && r.daysOfCover < URGENT).length;
  const idle = rows.filter((r) => r.daysOfCover == null && r.currentStock > 0).length;

  return (
    <Card className="overflow-hidden">
      <div className="space-y-1 border-b p-4">
        <h2 className="text-sm font-semibold tracking-tight">What is running out</h2>
        <p className="text-sm text-muted-foreground">
          Days of stock left at the rate each line has been selling, soonest first.{" "}
          {urgent > 0 ? (
            <>
              <span className="font-medium text-destructive">
                {urgent} {urgent === 1 ? "line has" : "lines have"} under {URGENT} days left.
              </span>{" "}
            </>
          ) : null}
          {/* Said plainly, because a rate from a fortnight of trading is a
              rough one and a reader has no way to know that from the table. */}
          Worked out from {dataDays} {dataDays === 1 ? "day" : "days"} of sales
          {dataDays < 30 ? " - a short run, so treat the rates as rough" : ""}.
        </p>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">In stock</TableHead>
              <TableHead className="text-right">Selling</TableHead>
              <TableHead className="text-right">Lasts</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  Nothing to show yet.
                </TableCell>
              </TableRow>
            ) : (
              shown.map((row) => (
                <TableRow key={row.productId}>
                  <TableCell>
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium">{row.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {row.packagingType} · {row.variantValue}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="num text-right">{qty(row.currentStock)}</TableCell>
                  <TableCell className="num text-right text-muted-foreground">
                    {row.unitsPerDay > 0 ? `${row.unitsPerDay.toFixed(1)} / day` : "-"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge variant={coverTone(row.daysOfCover)}>{coverLabel(row)}</Badge>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {rows.length > shown.length ? (
        <p className="border-t px-4 py-3 text-xs text-muted-foreground">
          {rows.length - shown.length} more {rows.length - shown.length === 1 ? "line" : "lines"} not
          shown
          {idle > 0 ? `, including ${idle} holding stock that has not sold at all` : ""}.
        </p>
      ) : null}
    </Card>
  );
}
