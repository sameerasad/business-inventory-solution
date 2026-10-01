"use client";

import { useActionState, useEffect, useState } from "react";
import { Undo2, Wallet } from "lucide-react";

import {
  clearAllReceivablesAction,
  getLastClearance,
  previewClearAllAction,
  undoClearanceAction,
  type ClearancePreview,
  type LastClearance,
} from "@/actions/bulk-payments";
import { emptyActionState } from "@/lib/validations";
import { dateOnly, money, todayInputValue } from "@/lib/format";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/forms/form-bits";

/**
 * Settle every outstanding invoice in one press.
 *
 * The figures are fetched when the dialog opens rather than passed in from the
 * page, and on purpose: the page's list is filtered by area, booker, age and
 * search, and this clears all of it regardless. A number taken from the
 * filtered view would quietly understate what the button does.
 *
 * Typing the count is the confirmation. It is not there to slow anyone down for
 * its own sake - the server checks the number against what it finds at the
 * moment of writing, so a payment recorded by somebody else in between turns
 * the press into a refusal instead of a surprise.
 */
export function BulkClearDialog() {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<ClearancePreview | null>(null);
  const [last, setLast] = useState<LastClearance | null>(null);
  const [loading, setLoading] = useState(false);

  const [paidOn, setPaidOn] = useState(todayInputValue());
  const [method, setMethod] = useState("Cash");
  const [typed, setTyped] = useState("");

  const [state, formAction, isPending] = useActionState(clearAllReceivablesAction, emptyActionState);
  const [undoState, undoAction, undoPending] = useActionState(undoClearanceAction, emptyActionState);

  /** Re-read on open, and again after either action, so the figures are never stale. */
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    void Promise.all([previewClearAllAction(), getLastClearance()])
      .then(([p, l]) => {
        if (!alive) return;
        setPreview(p);
        setLast(l);
        setTyped("");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, state, undoState]);

  const nothingOwed = preview != null && preview.invoices === 0;
  const matches = preview != null && Number.parseInt(typed, 10) === preview.invoices;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Wallet className="h-4 w-4" />
        Clear all
      </Button>

      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Clear every outstanding invoice</DialogTitle>
          <DialogDescription>
            Records a payment for the full remaining balance of every unpaid invoice, for every
            shop. Stock and revenue are untouched - the sale was recorded when the goods went out.
          </DialogDescription>
        </DialogHeader>

        {state.message ? (
          <Alert tone={state.ok ? "success" : "error"}>{state.message}</Alert>
        ) : null}
        {undoState.message ? (
          <Alert tone={undoState.ok ? "success" : "error"}>{undoState.message}</Alert>
        ) : null}

        {loading && preview === null ? (
          <p className="text-sm text-muted-foreground">Checking what is outstanding...</p>
        ) : nothingOwed ? (
          <Alert tone="success">Nothing is outstanding. Every invoice is already paid.</Alert>
        ) : preview ? (
          <>
            <div className="grid grid-cols-3 gap-3 rounded-md bg-muted p-3 text-sm">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Invoices</p>
                <p className="num font-semibold">{preview.invoices}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Shops</p>
                <p className="num font-semibold">{preview.shops}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Total</p>
                <p className="num font-semibold" style={{ color: "#006300" }}>
                  {money(preview.total)}
                </p>
              </div>
            </div>

            <form action={formAction} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Received on"
                  htmlFor="bulk-paid-on"
                  required
                  error={state.fieldErrors.paidOn}
                >
                  <Input
                    id="bulk-paid-on"
                    name="paidOn"
                    type="date"
                    value={paidOn}
                    onChange={(e) => setPaidOn(e.target.value)}
                    disabled={isPending}
                    required
                  />
                </Field>

                <Field label="Method" htmlFor="bulk-method" error={state.fieldErrors.method}>
                  <Input
                    id="bulk-method"
                    name="method"
                    list="bulk-methods"
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                    placeholder="Cash"
                    disabled={isPending}
                  />
                  <datalist id="bulk-methods">
                    <option value="Cash" />
                    <option value="Bank transfer" />
                    <option value="Easypaisa" />
                    <option value="JazzCash" />
                    <option value="Cheque" />
                  </datalist>
                </Field>
              </div>

              <Field
                label={`Type ${preview.invoices} to confirm`}
                htmlFor="bulk-confirm"
                required
                error={state.fieldErrors.confirmCount}
                hint="The oldest unpaid invoice is from this many days ago: the figure above covers every shop, not just the ones currently filtered."
              >
                <Input
                  id="bulk-confirm"
                  name="confirmCount"
                  inputMode="numeric"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={String(preview.invoices)}
                  disabled={isPending}
                  required
                />
              </Field>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setOpen(false)}
                  disabled={isPending}
                >
                  Cancel
                </Button>
                <SubmitButton
                  pending={isPending}
                  pendingLabel="Clearing..."
                  disabled={!matches}
                  variant="destructive"
                >
                  Clear {preview.invoices} and record {money(preview.total)}
                </SubmitButton>
              </DialogFooter>
            </form>
          </>
        ) : null}

        {/* ------------------------------------------------------------ undo */}
        {last ? (
          <form action={undoAction} className="space-y-2 border-t pt-4">
            <input type="hidden" name="batchId" value={last.batchId} />
            <p className="text-sm text-muted-foreground">
              Last clearance: {last.invoices} {last.invoices === 1 ? "invoice" : "invoices"} for{" "}
              <span className="num font-medium">{money(last.total)}</span>, dated{" "}
              {dateOnly(last.paidOn)}.
            </p>
            <SubmitButton
              pending={undoPending}
              pendingLabel="Undoing..."
              variant="outline"
              size="sm"
            >
              <Undo2 className="h-3.5 w-3.5" />
              Undo that clearance
            </SubmitButton>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
