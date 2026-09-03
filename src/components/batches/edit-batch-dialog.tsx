"use client";

import { updateBatchAction } from "@/actions/batches";
import { EditDialog } from "@/components/forms/edit-dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { money, qty } from "@/lib/format";

/**
 * Correct a received batch.
 *
 * Two things are worth saying out loud in the UI, because both surprise people:
 *
 *  - Quantity cannot go below what has already been sold out of the batch. The
 *    minimum is shown rather than left to be discovered on submit.
 *  - Changing the unit cost changes the margin on every sale from this batch.
 *    That is the point after a supplier invoice correction, and a mistake
 *    otherwise, so the number of affected sales is stated.
 */
export function EditBatchDialog({
  batch,
}: {
  batch: {
    id: number;
    sku: string;
    quantity: number;
    remainingQty: number;
    unitCost: number;
    receivedDate: string;
    notes: string | null;
    /** Live sales drawn from this batch. */
    saleCount: number;
  };
}) {
  const sold = batch.quantity - batch.remainingQty;

  return (
    <EditDialog
      action={updateBatchAction}
      title={`Edit batch #${batch.id}`}
      description={`${batch.sku}. ${qty(sold)} of ${qty(batch.quantity)} sold, ${qty(batch.remainingQty)} left.`}
      formKey={`${batch.id}-${batch.quantity}-${batch.unitCost}-${batch.receivedDate}`}
      footerNote={
        batch.saleCount > 0
          ? `Changing the unit cost re-costs ${batch.saleCount} sale(s) from this batch, so their profit changes with it. The product cannot be changed - that would be a different batch.`
          : "The product cannot be changed - that would be a different batch."
      }
    >
      {(state, isPending) => (
        <>
          <input type="hidden" name="id" value={batch.id} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Quantity received"
              htmlFor={`b-qty-${batch.id}`}
              required
              error={state.fieldErrors.quantity}
              hint={sold > 0 ? `At least ${sold} - that many are already sold.` : undefined}
            >
              <Input
                id={`b-qty-${batch.id}`}
                name="quantity"
                type="number"
                min={Math.max(1, sold)}
                step={1}
                defaultValue={batch.quantity}
                disabled={isPending}
                required
              />
            </Field>

            <Field
              label="Unit cost"
              htmlFor={`b-cost-${batch.id}`}
              required
              error={state.fieldErrors.unitCost}
              hint={`Currently ${money(batch.unitCost)} per unit.`}
            >
              <Input
                id={`b-cost-${batch.id}`}
                name="unitCost"
                type="number"
                min={0}
                step="0.01"
                defaultValue={batch.unitCost.toFixed(2)}
                disabled={isPending}
                required
              />
            </Field>
          </div>

          <Field
            label="Received date"
            htmlFor={`b-date-${batch.id}`}
            required
            error={state.fieldErrors.receivedDate}
            hint="Also decides which batch is drained first on a booking."
          >
            <Input
              id={`b-date-${batch.id}`}
              name="receivedDate"
              type="date"
              defaultValue={batch.receivedDate}
              disabled={isPending}
              required
            />
          </Field>

          <Field label="Notes" htmlFor={`b-notes-${batch.id}`} error={state.fieldErrors.notes}>
            <Textarea
              id={`b-notes-${batch.id}`}
              name="notes"
              rows={2}
              defaultValue={batch.notes ?? ""}
              disabled={isPending}
            />
          </Field>
        </>
      )}
    </EditDialog>
  );
}
