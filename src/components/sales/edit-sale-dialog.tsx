"use client";

import { useMemo, useState } from "react";

import { updateSaleAction } from "@/actions/sales";
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
