"use client";

import { useCallback, useEffect, useState } from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";

/** How long to wait for typing to stop before asking the server again. */
const SETTLE_MS = 300;

/**
 * A field whose value lives in the URL, but which does not go there per
 * keystroke.
 *
 * Every filter on every list is a server round trip: the page re-queries and
 * re-renders from the URL. Committing on each keystroke means a query per
 * letter, all but the last one thrown away - and it fights the keyboard, since
 * each navigation re-renders the input underneath the cursor.
 *
 * So the text is local while it is being typed and only reaches the URL once it
 * settles. Three details this has to get right:
 *
 *  - The field must follow the URL when the URL changes from elsewhere: the
 *    Clear button, a shared link, the back button. Hence the incoming value is
 *    copied into local state whenever it changes.
 *  - The debounce is skipped when the two already agree, which is also what
 *    stops them chasing each other in a loop.
 *  - CLEARING is immediate. Emptying a filter is a request to see everything
 *    again, and making that wait feels like the app has stalled - where waiting
 *    out a few more letters does not.
 */
export function useDebouncedCommit(
  value: string,
  onCommit: (next: string | null) => void,
  delay = SETTLE_MS,
) {
  const [text, setText] = useState(value);

  useEffect(() => {
    setText(value);
  }, [value]);

  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === value) return;
    const timer = setTimeout(() => onCommit(trimmed || null), trimmed === "" ? 0 : delay);
    return () => clearTimeout(timer);
  }, [text, value, onCommit, delay]);

  /** For Enter, which should not have to wait out the debounce. */
  const commitNow = useCallback(() => {
    onCommit(text.trim() || null);
  }, [onCommit, text]);

  return { text, setText, commitNow };
}

export function SearchBox({
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
  const { text, setText, commitNow } = useDebouncedCommit(value, onCommit);

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        id={id}
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter commits at once, and must not submit anything: this row sits
          // above a table, not inside a form.
          if (e.key !== "Enter") return;
          e.preventDefault();
          commitNow();
        }}
        placeholder={placeholder ?? "Search"}
        className="pl-8"
      />
    </div>
  );
}

/**
 * A date filter that waits for the date to be finished.
 *
 * Worth debouncing for a reason that is easy to miss: a date input is not one
 * value, it is three, and typing the year produces a run of complete valid
 * dates on the way. Typing 2026 into an empty year goes through 0002, 0020 and
 * 0202 first, each of which fires a change and each of which was a separate
 * query for a range nobody asked about. Picking a date from the calendar fires
 * once either way.
 */
export function DateBox({
  id,
  value,
  onCommit,
}: {
  id: string;
  value: string;
  onCommit: (value: string | null) => void;
}) {
  const { text, setText } = useDebouncedCommit(value, onCommit);

  return <Input id={id} type="date" value={text} onChange={(e) => setText(e.target.value)} />;
}
