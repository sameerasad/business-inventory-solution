"use client";

import { useCallback, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValueLabel,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";

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
  selected,
}: {
  years: number[];
  categories: { id: number; name: string }[];
  areas: { id: number; name: string }[];
  selected: { year: number; categoryId: number | null; areaId: number | null };
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

  const categoryLabel =
    selected.categoryId == null
      ? "All categories"
      : (categories.find((c) => c.id === selected.categoryId)?.name ?? "All categories");
  const areaLabel =
    selected.areaId == null
      ? "All areas"
      : (areas.find((a) => a.id === selected.areaId)?.name ?? "All areas");

  return (
    <div className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
      <div className="w-[110px] space-y-1.5">
        <Label htmlFor="filter-year">Year</Label>
        <Select value={String(selected.year)} onValueChange={(v) => setParam("year", v)}>
          <SelectTrigger id="filter-year" aria-label="Year">
            <SelectValueLabel label={selected.year} />
          </SelectTrigger>
          <SelectContent>
            {years.map((y) => (
              <SelectItem key={y} value={String(y)}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="w-[190px] space-y-1.5">
        <Label htmlFor="filter-category">Category</Label>
        <Select
          value={selected.categoryId == null ? ALL : String(selected.categoryId)}
          onValueChange={(v) => setParam("category", v)}
        >
          <SelectTrigger id="filter-category" aria-label="Category">
            <SelectValueLabel label={categoryLabel} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="w-[190px] space-y-1.5">
        <Label htmlFor="filter-area">Area</Label>
        <Select
          value={selected.areaId == null ? ALL : String(selected.areaId)}
          onValueChange={(v) => setParam("area", v)}
        >
          <SelectTrigger id="filter-area" aria-label="Area">
            <SelectValueLabel label={areaLabel} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All areas</SelectItem>
            {areas.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
