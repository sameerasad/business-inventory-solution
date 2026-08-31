import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Server-rendered prev/next that carries the current filters along in the query
 * string, so paging never silently drops a filter.
 */
export function Pagination({
  page,
  pageCount,
  total,
  pageSize,
  basePath,
  params,
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  basePath: string;
  params: Record<string, string | undefined>;
}) {
  const href = (targetPage: number) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, value);
    }
    if (targetPage > 1) search.set("page", String(targetPage));
    const qs = search.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <p className="num text-xs text-muted-foreground">
        {total === 0 ? "No rows" : `Showing ${first}-${last} of ${total}`}
      </p>
      {pageCount > 1 ? (
        <div className="flex items-center gap-2">
          {page > 1 ? (
            <Link
              href={href(page - 1)}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              Previous
            </Link>
          ) : (
            <span className={cn(buttonVariants({ variant: "outline", size: "sm" }), "pointer-events-none opacity-50")}>
              Previous
            </span>
          )}
          <span className="num text-xs text-muted-foreground">
            Page {page} of {pageCount}
          </span>
          {page < pageCount ? (
            <Link
              href={href(page + 1)}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              Next
            </Link>
          ) : (
            <span className={cn(buttonVariants({ variant: "outline", size: "sm" }), "pointer-events-none opacity-50")}>
              Next
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
