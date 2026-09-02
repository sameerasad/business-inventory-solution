"use client";

import { useActionState, useEffect, useState } from "react";
import { Check, MapPin, X } from "lucide-react";

import { setBookerAreasAction } from "@/actions/bookers";
import { emptyActionState } from "@/lib/validations";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/forms/form-bits";
import { cn } from "@/lib/utils";

export type AreaChoice = { id: number; name: string };

/**
 * Assigns areas to one booker.
 *
 * The whole territory is posted at once as a JSON array rather than as a
 * checkbox group: an all-unchecked checkbox group posts nothing at all, which is
 * indistinguishable from the form never having rendered, and would silently skip
 * clearing a territory instead of clearing it.
 */
export function TerritoryEditor({
  bookerId,
  bookerName,
  areas,
  assigned,
}: {
  bookerId: number;
  bookerName: string;
  areas: AreaChoice[];
  assigned: AreaChoice[];
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(setBookerAreasAction, emptyActionState);
  const [picked, setPicked] = useState<number[]>(() => assigned.map((a) => a.id));

  useEffect(() => {
    if (state.ok) setOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // The server is the source of truth, so a save elsewhere (or a failed save)
  // must not leave stale ticks behind.
  useEffect(() => {
    setPicked(assigned.map((a) => a.id));
  }, [assigned]);

  const toggle = (id: number) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  if (!open) {
    return (
      <div className="mt-2.5 border-t pt-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <MapPin className="h-3.5 w-3.5" />
            Territory
          </span>
          {assigned.length === 0 ? (
            <span className="text-xs text-muted-foreground">None assigned</span>
          ) : (
            assigned.map((a) => (
              <Badge key={a.id} variant="secondary" className="font-normal">
                {a.name}
              </Badge>
            ))
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-7"
            onClick={() => setOpen(true)}
            disabled={areas.length === 0}
            title={
              areas.length === 0
                ? "Add an area on the Areas & Shops page first"
                : `Assign areas to ${bookerName}`
            }
          >
            {assigned.length === 0 ? "Assign areas" : "Change"}
          </Button>
        </div>
        {state.message ? (
          <p className={cn("mt-1.5 text-xs", state.ok ? "text-muted-foreground" : "text-destructive")}>
            {state.message}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={formAction} className="mt-2.5 space-y-2 border-t pt-2.5">
      <input type="hidden" name="bookerId" value={bookerId} />
      <input type="hidden" name="areaIds" value={JSON.stringify(picked)} />

      {state.message && !state.ok ? <Alert tone="error">{state.message}</Alert> : null}

      <p className="text-xs font-medium text-muted-foreground">
        Areas {bookerName} is responsible for
      </p>

      <div className="flex flex-wrap gap-1.5">
        {areas.map((area) => {
          const on = picked.includes(area.id);
          return (
            <button
              key={area.id}
              type="button"
              onClick={() => toggle(area.id)}
              aria-pressed={on}
              disabled={isPending}
              className={cn(
                "flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                on
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {on ? <Check className="h-3 w-3" /> : null}
              {area.name}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <SubmitButton pending={isPending}>Save territory ({picked.length})</SubmitButton>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Cancel"
          onClick={() => {
            setPicked(assigned.map((a) => a.id));
            setOpen(false);
          }}
        >
          <X className="h-4 w-4" />
        </Button>
        {/* Clearing a territory is a legitimate act, not an accident, so it gets
            its own control rather than making someone untick eight chips. */}
        {picked.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => setPicked([])}
          >
            Clear all
          </Button>
        ) : null}
      </div>
    </form>
  );
}
