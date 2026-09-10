"use client";

import { useCallback, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DateBox, SearchBox } from "@/components/filter-fields";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";

const ALL = "all";

export type FilterSpec =
  | {
      kind: "select";
      key: string;
      label: string;
      value: string;
      allLabel?: string;
      width?: string;
      options: { value: string; label: string }[];
    }
  | {
      kind: "date";
      key: string;
      label: string;
      value: string;
      width?: string;
    }
  | {
      kind: "search";
      key: string;
      label: string;
      value: string;
      /** Shown inside the empty box: say what it actually searches. */
      placeholder?: string;
      width?: string;
    };

/**
 * The filter row above a table. Selections live in the URL so the server
 * component re-queries with them, and a filtered table can be linked to.
 * Changing any filter resets the page number - page 7 of a narrower result set is
 * usually empty.
 */
export function ListFilters({ filters }: { filters: FilterSpec[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (!value || value === ALL) params.delete(key);
      else params.set(key, value);
      params.delete("page");
      startTransition(() => {
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      });
    },
    [pathname, router, searchParams],
  );

  const hasActive = filters.some((f) => f.value && f.value !== ALL);

  return (
    <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
      {filters.map((filter) => (
        <div key={filter.key} className={filter.width ?? "w-[200px]"}>
          <div className="space-y-1.5">
            <Label htmlFor={`filter-${filter.key}`}>{filter.label}</Label>
            {filter.kind === "select" ? (
              <SearchableSelect
                id={`filter-${filter.key}`}
                value={filter.value || ALL}
                allLabel={filter.allLabel ?? "All"}
                options={filter.options}
                onChange={(v) => setParam(filter.key, v)}
              />
            ) : filter.kind === "search" ? (
              <SearchBox
                id={`filter-${filter.key}`}
                value={filter.value}
                placeholder={filter.placeholder}
                onCommit={(v) => setParam(filter.key, v)}
              />
            ) : (
              <DateBox
                id={`filter-${filter.key}`}
                value={filter.value}
                onCommit={(v) => setParam(filter.key, v)}
              />
            )}
          </div>
        </div>
      ))}

      {hasActive ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            startTransition(() => router.replace(pathname, { scroll: false }));
          }}
        >
          <X className="h-4 w-4" />
          Clear
        </Button>
      ) : null}

      <div aria-live="polite" className="flex h-10 items-center text-xs text-muted-foreground">
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      </div>
    </div>
  );
}
