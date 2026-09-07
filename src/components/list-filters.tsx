"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
 * A text box that waits for you to stop typing.
 *
 * Two things it has to get right. Typing must feel immediate, so the text is
 * local state rather than the URL - a round trip per keystroke would fight the
 * keyboard. And the box must follow the URL when the URL changes from
 * somewhere else: the Clear button, a shared link, the back button. Hence the
 * value it is given is copied into local state whenever it changes, and the
 * debounce is skipped when the two already agree, which is also what stops the
 * two from chasing each other.
 */
function SearchBox({
  id,
  value,
  placeholder,
  onCommit,
}: {
  id: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string | null) => void;
}) {
  const [text, setText] = useState(value);

  useEffect(() => {
    setText(value);
  }, [value]);

  useEffect(() => {
    if (text.trim() === value) return;
    const timer = setTimeout(() => onCommit(text.trim() || null), 350);
    return () => clearTimeout(timer);
  }, [text, value, onCommit]);

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        id={id}
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter should not wait out the debounce, and must not submit
          // anything: this row sits above a table, not inside a form.
          if (e.key !== "Enter") return;
          e.preventDefault();
          onCommit(text.trim() || null);
        }}
        placeholder={placeholder ?? "Search"}
        className="pl-8"
      />
    </div>
  );
}

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
              <Input
                id={`filter-${filter.key}`}
                type="date"
                defaultValue={filter.value}
                onChange={(e) => setParam(filter.key, e.target.value || null)}
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
