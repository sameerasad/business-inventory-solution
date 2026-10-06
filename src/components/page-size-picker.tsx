"use client";

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { DEFAULT_PAGE_SIZE, PAGE_SIZES } from "@/lib/lists";

/**
 * How many rows to show at once.
 *
 * Lives in the URL like every other listing choice, so a view can be linked to
 * and the server re-queries with it rather than the browser hiding rows it
 * already fetched - fetching a hundred rows to display ten is work nobody asked
 * for, on a phone over a mobile connection.
 *
 * Changing it drops the page number. Page 7 at ten rows is page 1 at a hundred,
 * and landing on an empty page after making the pages BIGGER reads as a bug.
 */
export function PageSizePicker({ value }: { value: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const choose = (next: number) => {
    const params = new URLSearchParams(searchParams.toString());
    // The default is the absence of the parameter: a URL carrying "per=30"
    // would survive a change to what the default is and quietly keep the old
    // one.
    if (next === DEFAULT_PAGE_SIZE) params.delete("per");
    else params.set("per", String(next));
    params.delete("page");
    startTransition(() => {
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    });
  };

  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span>Rows</span>
      <select
        className="h-7 rounded-md border bg-background px-1.5 text-xs"
        value={String(value)}
        disabled={pending}
        onChange={(e) => choose(Number.parseInt(e.target.value, 10))}
        aria-label="Rows per page"
      >
        {PAGE_SIZES.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}
