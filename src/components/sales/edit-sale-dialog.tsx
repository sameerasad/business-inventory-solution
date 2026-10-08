"use client";

import { useMemo, useState, useTransition } from "react";

import { updateSaleAction } from "@/actions/sales";
import { updateBatchCostAction } from "@/actions/batches";
import { emptyActionState } from "@/lib/validations";
import { Button } from "@/components/ui/button";
import { EditDialog } from "@/components/forms/edit-dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert } from "@/components/ui/alert";
import { money, qty } from "@/lib/format";
import type { AreaOption } from "@/components/forms/sale-form";

const NO_SHOP = "none";

/**
 * Correct the cost this sale was bought at.
 *
 * The cost belongs to the BATCH, not the sale - a sale has none of its own, it
 * inherits one, and profit is worked out from that join every time it is asked
 * for. So this is here because it is where the mistake is noticed (the profit
 * on an order looks wrong), not because the cost lives here.
 *
 * Which means it changes every sale from the same batch, and the count is on
 * the button rather than in a footnote. In the real data one batch feeds
 * thirty-one sales; a cost corrected from one of them quietly rewrites the
 * profit on the other thirty.
 *
 * Its own control rather than part of the sale form, for two reasons: a form
 * inside a form is not valid HTML, and nobody fixing a quantity should re-cost
 * thirty sales as a side effect of pressing Save.
 */
function CorrectCost({ batch }: { batch: SaleBatchOption }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(String(batch.unitCost));
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();

  const others = batch.salesCount - 1;
  const parsed = Number(value);
  const changed = Number.isFinite(parsed) && parsed >= 0 && Math.abs(parsed - batch.unitCost) >= 0.005;

  if (!open) {
    return (
      <button
        type="button"
        className="text-left text-xs font-medium text-muted-foreground underline underline-offset-2"
        onClick={() => {
          setValue(String(batch.unitCost));
          setNote(null);
          setOpen(true);
        }}
      >
        Cost wrong on batch #{batch.id}?
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-2.5 sm:col-span-2">
      <Field
        label={`Cost per unit on batch #${batch.id}`}
        htmlFor={`cost-${batch.id}`}
        hint={
          others > 0
            ? `${others} other ${others === 1 ? "sale draws" : "sales draw"} from this batch. Changing it re-costs ${others === 1 ? "that one" : "them"} too, including past months.`
            : "No other sale draws from this batch."
        }
      >
        <Input
          id={`cost-${batch.id}`}
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={pending}
        />
      </Field>

      {note ? (
        <Alert tone={note.ok ? "success" : "error"}>{note.message}</Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={others > 0 ? "destructive" : "default"}
          disabled={pending || !changed}
          onClick={() =>
            start(async () => {
              const form = new FormData();
              form.set("id", String(batch.id));
              form.set("unitCost", value);
              const result = await updateBatchCostAction(emptyActionState, form);
              setNote({ ok: result.ok, message: result.message ?? "" });
              if (result.ok) setOpen(false);
            })
          }
        >
          {pending
            ? "Saving..."
            : others > 0
              ? `Correct it and re-cost ${others + 1} sales`
              : "Correct it"}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export type EditableSale = {
  id: number;
  productId: number;
  sku: string;
  batchId: number;
  quantity: number;
  salePrice: number;
  saleDate: string;
  areaId: number;
  shopId: number | null;
  notes: string | null;
  /** The invoice this line belongs to, if any. */
  invoiceNo: string | null;
  /** Cash already received against that invoice. */
  paid: number;
};

export type SaleBatchOption = {
  id: number;
  unitCost: number;
  remainingQty: number;
  receivedDate: string;
  /** Live sales drawing their cost from this batch, this one included. */
  salesCount: number;
};

/**
 * Correct a recorded sale: batch, area, shop, quantity, price, date.
 *
 * The batch is editable because a sale entered against the wrong batch is a
 * common slip, and the only honest fix is to put the stock back and take it from
 * the right one. The product is not: a different product is a different sale.
 *
 * Headroom in the current batch includes this sale's own quantity, since those
 * units are already its own - otherwise raising 10 to 11 in a full batch would
 * look impossible.
 */
export function EditSaleDialog({
  sale,
  batches,
  areas,
}: {
  sale: EditableSale;
  batches: SaleBatchOption[];
  areas: AreaOption[];
}) {
  const [batchId, setBatchId] = useState(String(sale.batchId));
  const [areaId, setAreaId] = useState(String(sale.areaId));
  const [shopId, setShopId] = useState(sale.shopId == null ? NO_SHOP : String(sale.shopId));
  const [quantity, setQuantity] = useState(String(sale.quantity));
  const [price, setPrice] = useState(sale.salePrice.toFixed(2));

  const selectedBatch = batches.find((b) => String(b.id) === batchId) ?? null;
  const selectedArea = areas.find((a) => String(a.id) === areaId) ?? null;

  const headroom = useMemo(() => {
    if (!selectedBatch) return 0;
    return selectedBatch.id === sale.batchId
      ? selectedBatch.remainingQty + sale.quantity
      : selectedBatch.remainingQty;
  }, [selectedBatch, sale.batchId, sale.quantity]);

  const q = Number.parseInt(quantity, 10);
  const p = Number.parseFloat(price);
  const overStock = Number.isFinite(q) && q > headroom;
  const newTotal = Number.isFinite(q) && Number.isFinite(p) ? q * p : null;
  // An invoice must never be worth less than has been received against it.
  const undercutsPayment =
    sale.invoiceNo != null && newTotal != null && sale.paid > 0 && newTotal < sale.paid;

  return (
    <EditDialog
      action={updateSaleAction}
      title={`Edit sale #${sale.id}`}
      description={`${sale.sku}${sale.invoiceNo ? ` on ${sale.invoiceNo}` : " (counter sale)"}. Stock is returned to the old batch and taken from the new one, so totals stay exact.`}
      formKey={`${sale.id}-${sale.batchId}-${sale.quantity}-${sale.salePrice}-${sale.saleDate}`}
      footerNote="The product cannot be changed here - a different product is a different sale."
    >
      {(state, isPending) => (
        <>
          <input type="hidden" name="id" value={sale.id} />
          <input type="hidden" name="batchId" value={batchId} />
          <input type="hidden" name="areaId" value={areaId} />
          <input type="hidden" name="shopId" value={shopId === NO_SHOP ? "" : shopId} />

          {overStock ? (
            <Alert tone="error">
              Batch #{selectedBatch?.id} can only cover {qty(headroom)} unit(s) for this sale.
            </Alert>
          ) : null}

          {undercutsPayment ? (
            <Alert tone="error">
              {sale.invoiceNo} has {money(sale.paid)} paid against it. At {qty(q)} x {money(p)} the
              invoice would be worth {money(newTotal!)}, less than has been received. Reduce the
              payment first.
            </Alert>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Batch to sell from"
              required
              error={state.fieldErrors.batchId}
              hint={
                selectedBatch
                  ? `Cost ${money(selectedBatch.unitCost)} / unit. ${qty(headroom)} available to this sale.`
                  : undefined
              }
            >
              <Select value={batchId} onValueChange={setBatchId} disabled={isPending}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a batch" />
                </SelectTrigger>
                <SelectContent>
                  {batches.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)}>
                      #{b.id} · {b.receivedDate} · cost {money(b.unitCost)} ·{" "}
                      {b.id === sale.batchId
                        ? `${qty(b.remainingQty + sale.quantity)} available`
                        : `${qty(b.remainingQty)} left`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            {selectedBatch ? <CorrectCost batch={selectedBatch} /> : null}

            <Field
              label="Sale date"
              htmlFor={`s-date-${sale.id}`}
              required
              error={state.fieldErrors.saleDate}
            >
              <Input
                id={`s-date-${sale.id}`}
                name="saleDate"
                type="date"
                defaultValue={sale.saleDate}
                disabled={isPending}
                required
              />
            </Field>

            <Field
              label="Quantity"
              htmlFor={`s-qty-${sale.id}`}
              required
              error={state.fieldErrors.quantity}
            >
              <Input
                id={`s-qty-${sale.id}`}
                name="quantity"
                type="number"
                min={1}
                step={1}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                aria-invalid={overStock ? true : undefined}
                disabled={isPending}
                required
              />
            </Field>

            <Field
              label="Sale price"
              htmlFor={`s-price-${sale.id}`}
              required
              error={state.fieldErrors.salePrice}
              hint={
                newTotal != null && selectedBatch
                  ? `Line ${money(newTotal)}, profit ${money((p - selectedBatch.unitCost) * q)}.`
                  : undefined
              }
            >
              <Input
                id={`s-price-${sale.id}`}
                name="salePrice"
                type="number"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                disabled={isPending}
                required
              />
            </Field>

            <Field label="Area" required error={state.fieldErrors.areaId}>
              <Select
                value={areaId}
                onValueChange={(v) => {
                  setAreaId(v);
                  setShopId(NO_SHOP);
                }}
                disabled={isPending}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select an area" />
                </SelectTrigger>
                <SelectContent>
                  {areas.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Shop" error={state.fieldErrors.shopId}>
              <Select value={shopId} onValueChange={setShopId} disabled={isPending}>
                <SelectTrigger>
                  <SelectValue placeholder="Direct sale / no shop" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_SHOP}>Direct Sale / No Shop</SelectItem>
                  {(selectedArea?.shops ?? []).map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field label="Notes" htmlFor={`s-notes-${sale.id}`} error={state.fieldErrors.notes}>
            <Textarea
              id={`s-notes-${sale.id}`}
              name="notes"
              rows={2}
              defaultValue={sale.notes ?? ""}
              disabled={isPending}
            />
          </Field>
        </>
      )}
    </EditDialog>
  );
}
