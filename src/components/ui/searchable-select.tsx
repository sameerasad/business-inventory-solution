"use client";

import * as React from "react";
import { Check, ChevronDown, Search } from "lucide-react";

import { cn } from "@/lib/utils";

const ALL = "all";

export type SelectOption = { value: string; label: string };

/**
 * A select you can type into.
 *
 * Hand-written rather than built on the Radix select this app uses elsewhere,
 * because that component owns the keyboard while it is open - it implements its
 * own typeahead - and a text field placed inside its content does not reliably
 * receive what you type. A filter row with twenty-three shops and twenty-six
 * products in it needs a real search box, so this is a plain button and panel
 * with the same look.
 *
 * No portal: the panel is positioned against the trigger, which is safe here
 * because nothing above the filter row clips its overflow. If one of these ever
 * ends up inside a scrolling container, that stops being true.
 */
export function SearchableSelect({
  id,
  value,
  options,
  allLabel = "All",
  disabled,
  onChange,
  /**
   * Below this many options the search box is hidden and this behaves as an
   * ordinary dropdown. A search field above three choices is furniture: it
   * takes a tab stop and a line of height to save nobody any scrolling.
   */
  searchThreshold = 8,
}: {
  id?: string;
  value: string;
  options: SelectOption[];
  allLabel?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  searchThreshold?: number;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);

  const wrapRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  const searchable = options.length >= searchThreshold;

  // "All" is an option like any other, so one arrow key reaches it and the
  // keyboard never has to treat clearing the filter as a special case.
  const shown = React.useMemo(() => {
    const all: SelectOption[] = [{ value: ALL, label: allLabel }];
    const needle = query.trim().toLowerCase();
    if (!needle) return all.concat(options);
    return all
      .concat(options)
      .filter((o) => o.value === ALL || o.label.toLowerCase().includes(needle));
  }, [options, query, allLabel]);

  const selectedLabel =
    !value || value === ALL ? allLabel : (options.find((o) => o.value === value)?.label ?? allLabel);

  const close = React.useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  /* Clicking anywhere else closes it. pointerdown rather than click, so a
     press that lands on another control does not also get swallowed. */
  React.useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, close]);

  React.useEffect(() => {
    if (!open) return;
    const index = shown.findIndex((o) => o.value === (value || ALL));
    setActive(index >= 0 ? index : 0);
    if (searchable) searchRef.current?.focus();
  }, [open, searchable, value, shown]);

  // Keep the highlighted row in view when arrowing through a long list.
  React.useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({
      block: "nearest",
    });
  }, [active, open]);

  const pick = (next: string) => {
    onChange(next === ALL ? ALL : next);
    close();
    triggerRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => {
        if (shown.length === 0) return 0;
        return (current + step + shown.length) % shown.length;
      });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      // Never submits: this sits inside the filter row, which sits above a
      // table, but the same component may be dropped into a form later.
      event.stopPropagation();
      const chosen = shown[active];
      if (chosen) pick(chosen.value);
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "Enter")) {
            event.preventDefault();
            setOpen(true);
            return;
          }
          if (open) onKeyDown(event);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex h-10 w-full items-center justify-between rounded-md border border-input bg-card px-3 py-2 text-sm",
          "ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
          "disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground",
        )}
      >
        <span className="line-clamp-1 text-left">{selectedLabel}</span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
      </button>

      {open ? (
        <div className="absolute z-50 mt-1 w-full min-w-[200px] overflow-hidden rounded-md border bg-card shadow-md">
          {searchable ? (
            <div className="relative border-b">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
                placeholder="Type to filter"
                aria-label="Filter the options"
                className="h-9 w-full bg-transparent pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          ) : null}

          <div ref={listRef} role="listbox" className="max-h-60 overflow-y-auto p-1">
            {shown.length === 0 ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">No match.</p>
            ) : (
              shown.map((option, index) => {
                const selected = option.value === (value || ALL);
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-index={index}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => pick(option.value)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
                      index === active ? "bg-accent text-accent-foreground" : null,
                    )}
                  >
                    <Check className={cn("h-4 w-4 shrink-0", selected ? "" : "invisible")} />
                    <span className="line-clamp-1">{option.label}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
