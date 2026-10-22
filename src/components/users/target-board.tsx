"use client";

import { useActionState } from "react";

import { setTargetAction } from "@/actions/users";
import { emptyActionState } from "@/lib/validations";
import { money, qty } from "@/lib/format";
import { Alert } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/forms/form-bits";

export type TargetRow = {
  bookerId: number;
  name: string;
  amount: number | null;
  packs: number | null;
  notes: string | null;
  /** What they have actually done this month, so the target is set in context. */
  bookedSoFar: number;
  packsSoFar: number;
};

/**
 * This month's targets, one booker per row.
 *
 * Each row posts on its own. One big form saving every booker at once would
 * make a mistyped figure for one person fail the save for all of them, and
 * targets get revised one at a time anyway - usually mid-month, usually for
 * whoever just asked.
 */
export function TargetBoard({ month, rows }: { month: string; rows: TargetRow[] }) {
  if (rows.length === 0) {
    return (
      <Alert tone="info">
        No active bookers, so there is nobody to set a target for. Add one on the Bookers page
        first.
      </Alert>
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {rows.map((row) => (
        <TargetCard key={row.bookerId} month={month} row={row} />
      ))}
    </div>
  );
}

function TargetCard({ month, row }: { month: string; row: TargetRow }) {
  const [state, formAction, isPending] = useActionState(setTargetAction, emptyActionState);

  return (
    <Card>
      <CardContent className="p-4">
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="bookerId" value={row.bookerId} />
          <input type="hidden" name="month" value={month} />

          <div className="flex items-baseline justify-between gap-3">
            <p className="truncate font-medium">{row.name}</p>
            <p className="num shrink-0 text-xs text-muted-foreground">
              {money(row.bookedSoFar)} · {qty(row.packsSoFar)} packs so far
            </p>
          </div>

          {state.message ? (
            <Alert tone={state.ok ? "success" : "error"}>{state.message}</Alert>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`amount-${row.bookerId}`}>Rupees</Label>
              <Input
                id={`amount-${row.bookerId}`}
                name="amount"
                inputMode="decimal"
                placeholder="No target"
                defaultValue={row.amount == null ? "" : String(row.amount)}
                disabled={isPending}
              />
              {state.fieldErrors.amount ? (
                <p className="text-xs font-medium text-destructive">{state.fieldErrors.amount}</p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`packs-${row.bookerId}`}>Packs</Label>
              <Input
                id={`packs-${row.bookerId}`}
                name="packs"
                inputMode="numeric"
                placeholder="No target"
                defaultValue={row.packs == null ? "" : String(row.packs)}
                disabled={isPending}
              />
              {state.fieldErrors.packs ? (
                <p className="text-xs font-medium text-destructive">{state.fieldErrors.packs}</p>
              ) : null}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`notes-${row.bookerId}`}>Note for them</Label>
            <Input
              id={`notes-${row.bookerId}`}
              name="notes"
              placeholder="Shown on their target page"
              defaultValue={row.notes ?? ""}
              disabled={isPending}
            />
          </div>

          <SubmitButton pending={isPending} pendingLabel="Saving..." size="sm" variant="outline">
            Save target
          </SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}
