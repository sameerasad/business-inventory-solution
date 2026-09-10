"use client";

import { useCallback, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DateBox } from "@/components/filter-fields";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";

const ALL = "all";

/**
 * Filters live in the URL, not in component state, so every chart on the page is
 * rendered on the server from the same parameters and a filtered view can be
 * bookmarked or shared. Changing a filter is a router navigation; the pending
 * transition drives the spinner.
 */
export function DashboardFilters({
  years,
  categories,
  areas,
  bookers,
  selected,
}: {
  years: number[];
  categories: { id: number; name: string }[];
  areas: { id: number; name: string }[];
  bookers: { id: number; name: string }[];
  selected: {
    year: number;
    categoryId: number | null;
    areaId: number | null;
    bookerId: number | null;
    from: string | null;
    to: string | null;
  };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === null || value === ALL) params.delete(key);
      else params.set(key, value);
      startTransition(() => {
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      });
    },
    [pathname, router, searchParams],
  );

  const clearRange = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("from");
    params.delete("to");
    startTransition(() => {
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    });
  };

  const hasRange = Boolean(selected.from || selected.to);

  return (
    <div className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
      <div className="w-[110px] space-y-1.5">
        <Label htmlFor="filter-year">Year</Label>
        <SearchableSelect
          id="filter-year"
          value={String(selected.year)}
          // Every figure on this page belongs to one period, so there is no
          // "all years" to offer - and offering one anyway listed the current
          // year twice.
          includeAll={false}
          options={years.map((y) => ({ value: String(y), label: String(y) }))}
          onChange={(v) => setParam("year", v)}
          disabled={hasRange}
        />
      </div>

      {/* A range beats the year, so the two are shown together and the year is
          disabled while a range is set - rather than leaving a year selector
          that silently does nothing. */}
      <div className="w-[160px] space-y-1.5">
        <Label htmlFor="filter-from">From</Label>
        <DateBox
          id="filter-from"
          value={selected.from ?? ""}
          onCommit={(v) => setParam("from", v)}
        />
      </div>

      <div className="w-[160px] space-y-1.5">
        <Label htmlFor="filter-to">To</Label>
        <DateBox id="filter-to" value={selected.to ?? ""} onCommit={(v) => setParam("to", v)} />
      </div>

      {hasRange ? (
        <Button type="button" variant="ghost" onClick={clearRange}>
          <X className="h-4 w-4" />
          Back to the year
        </Button>
      ) : null}

      <div className="w-[190px] space-y-1.5">
        <Label htmlFor="filter-category">Category</Label>
        <SearchableSelect
          id="filter-category"
          value={selected.categoryId == null ? ALL : String(selected.categoryId)}
          allLabel="All categories"
          options={categories.map((c) => ({ value: String(c.id), label: c.name }))}
          onChange={(v) => setParam("category", v)}
        />
      </div>

      <div className="w-[190px] space-y-1.5">
        <Label htmlFor="filter-area">Area</Label>
        <SearchableSelect
          id="filter-area"
          value={selected.areaId == null ? ALL : String(selected.areaId)}
          allLabel="All areas"
          options={areas.map((a) => ({ value: String(a.id), label: a.name }))}
          onChange={(v) => setParam("area", v)}
        />
      </div>

      <div className="w-[190px] space-y-1.5">
        <Label htmlFor="filter-booker">Booker</Label>
        <SearchableSelect
          id="filter-booker"
          value={selected.bookerId == null ? ALL : String(selected.bookerId)}
          allLabel="All bookers"
          options={bookers.map((b) => ({ value: String(b.id), label: b.name }))}
          onChange={(v) => setParam("booker", v)}
        />
      </div>

      <div
        aria-live="polite"
        className="flex h-10 items-center gap-1.5 text-xs text-muted-foreground"
      >
        {pending ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Updating
          </>
        ) : null}
      </div>
    </div>
  );
}

/** Year / month toggle used by the area and shop charts. */
export function PeriodToggle({ value }: { value: "year" | "month" }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const set = (next: "year" | "month") => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "year") params.delete("period");
    else params.set("period", next);
    startTransition(() => {
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    });
  };

  return (
    <div
      role="group"
      aria-label="Period"
      data-pending={pending ? "" : undefined}
      className="inline-flex rounded-md border p-0.5 data-[pending]:opacity-60"
    >
      {(["year", "month"] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => set(option)}
          aria-pressed={value === option}
          className={
            value === option
              ? "rounded-[5px] bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
              : "rounded-[5px] px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          }
        >
          {option === "year" ? "Year" : "Month"}
        </button>
      ))}
    </div>
  );
}
