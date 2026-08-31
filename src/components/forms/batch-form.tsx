"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { createBatchAction } from "@/actions/batches";
import { emptyActionState } from "@/lib/validations";
import type { ProductOption } from "@/lib/queries";
import { money, todayInputValue } from "@/lib/format";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { ProductPicker } from "@/components/forms/product-picker";
import { SubmitButton, useIdempotencyKey } from "@/components/forms/form-bits";
import {
  cascade,
  EMPTY_SELECTION,
  type CascadeSelection,
} from "@/components/forms/product-cascade";

/**
 * Inventory IN. Everything the server needs travels as FormData, and the server
 * action re-validates all of it - the client-side checks here only exist to give
 * faster feedback.
 */
export function BatchForm({ products }: { products: ProductOption[] }) {
  const [state, formAction, isPending] = useActionState(createBatchAction, emptyActionState);
  const { key: idempotencyKey, rotate } = useIdempotencyKey();

  const [selection, setSelection] = useState<CascadeSelection>(EMPTY_SELECTION);
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [receivedDate, setReceivedDate] = useState(todayInputValue);
  const [notes, setNotes] = useState("");

  const resolved = useMemo(() => cascade(products, selection), [products, selection]);
  const product = resolved.product;

  // Clear the quantity / cost / notes after a save so the next receipt starts
  // clean, but keep the product and date - stock usually arrives in runs.
  useEffect(() => {
    if (state.ok) {
      setQuantity("");
      setUnitCost("");
      setNotes("");
      rotate();
    }
    // rotate is stable enough for this purpose; state identity changes per submit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const qtyNum = Number.parseInt(quantity, 10);
  const costNum = Number.parseFloat(unitCost);
  const totalCost =
    Number.isFinite(qtyNum) && Number.isFinite(costNum) && qtyNum > 0 && costNum >= 0
      ? qtyNum * costNum
      : null;

  const projectedMargin =
    product && Number.isFinite(costNum) && costNum >= 0 && product.defaultSalePrice > 0
      ? ((product.defaultSalePrice - costNum) / product.defaultSalePrice) * 100
      : null;

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      {state.message ? (
        <Alert tone={state.ok ? "success" : "error"}>
          {state.message}
          {state.ok ? (
            <>
              {" "}
              <Link href="/batches" className="font-medium underline">
                View all batches
              </Link>
            </>
          ) : null}
        </Alert>
      ) : null}

      <Card>
        <CardContent className="space-y-5 p-5">
          <ProductPicker
            resolved={resolved}
            onChange={(patch) => setSelection((prev) => ({ ...prev, ...patch }))}
            error={state.fieldErrors.productId}
            disabled={isPending}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-5 p-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Quantity received"
              htmlFor="quantity"
              required
              error={state.fieldErrors.quantity}
              hint={product ? `Number of ${product.unit}s` : undefined}
            >
              <Input
                id="quantity"
                name="quantity"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                placeholder="0"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                aria-invalid={state.fieldErrors.quantity ? true : undefined}
                disabled={isPending}
                required
              />
            </Field>

            <Field
              label="Unit cost"
              htmlFor="unitCost"
              required
              error={state.fieldErrors.unitCost}
              hint="Your cost per unit"
            >
              <Input
                id="unitCost"
                name="unitCost"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                placeholder="0.00"
                value={unitCost}
                onChange={(e) => setUnitCost(e.target.value)}
                aria-invalid={state.fieldErrors.unitCost ? true : undefined}
                disabled={isPending}
                required
              />
            </Field>

            <Field
              label="Received date"
              htmlFor="receivedDate"
              required
              error={state.fieldErrors.receivedDate}
            >
              <Input
                id="receivedDate"
                name="receivedDate"
                type="date"
                value={receivedDate}
                onChange={(e) => setReceivedDate(e.target.value)}
                aria-invalid={state.fieldErrors.receivedDate ? true : undefined}
                disabled={isPending}
                required
              />
            </Field>
          </div>

          <Field label="Notes" htmlFor="notes" error={state.fieldErrors.notes}>
            <Textarea
              id="notes"
              name="notes"
              placeholder="Supplier, invoice number, anything worth remembering."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={isPending}
            />
          </Field>

          {totalCost != null ? (
            <div className="flex flex-wrap gap-x-8 gap-y-1 rounded-md bg-muted px-3 py-2.5 text-sm">
              <span className="text-muted-foreground">
                Total batch cost{" "}
                <strong className="num text-foreground">{money(totalCost)}</strong>
              </span>
              {projectedMargin != null ? (
                <span className="text-muted-foreground">
                  Margin at default price{" "}
                  <strong className="num text-foreground">{projectedMargin.toFixed(1)}%</strong>
                </span>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <SubmitButton pending={isPending} disabled={!product} pendingLabel="Receiving...">
          Receive stock
        </SubmitButton>
        <Button type="button" variant="outline" asChild>
          <Link href="/batches">Cancel</Link>
        </Button>
        {!product ? (
          <p className="text-xs text-muted-foreground">Pick a product to continue.</p>
        ) : null}
      </div>
    </form>
  );
}
