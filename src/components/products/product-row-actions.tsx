"use client";

import { useActionState, useEffect, useState } from "react";
import { Pencil } from "lucide-react";

import { toggleProductActiveAction, updateProductPriceAction } from "@/actions/products";
import { emptyActionState } from "@/lib/validations";
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
 * Per-row controls: edit the default sale price, and retire or restore the entry.
 * Editing the price only affects what future sale forms pre-fill - recorded sales
 * keep the price they were sold at, so history never moves under you.
 */
export function ProductRowActions({
  productId,
  sku,
  defaultSalePrice,
  isActive,
  hasHistory,
}: {
  productId: number;
  sku: string;
  defaultSalePrice: number;
  isActive: boolean;
  hasHistory: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState(defaultSalePrice.toFixed(2));
  const [priceState, priceAction, pricePending] = useActionState(
    updateProductPriceAction,
    emptyActionState,
  );
  const [toggleState, toggleAction, togglePending] = useActionState(
    toggleProductActiveAction,
    emptyActionState,
  );

  useEffect(() => {
    if (priceState.ok) setOpen(false);
  }, [priceState]);

  return (
    <div className="flex items-center justify-end gap-1.5">
      {toggleState.message && !toggleState.ok ? (
        <span className="text-xs text-destructive">{toggleState.message}</span>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen(true)}
          aria-label={`Edit default price for ${sku}`}
        >
          <Pencil className="h-3.5 w-3.5" />
          Price
        </Button>

        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Default price for {sku}</DialogTitle>
            <DialogDescription>
              Used to pre-fill the New Sale form. Sales already recorded keep their own price.
            </DialogDescription>
          </DialogHeader>

          {priceState.message && !priceState.ok ? (
            <Alert tone="error">{priceState.message}</Alert>
          ) : null}

          <form action={priceAction} className="space-y-4">
            <input type="hidden" name="productId" value={productId} />
            <Field
              label="Default sale price"
              htmlFor={`price-${productId}`}
              required
              error={priceState.fieldErrors.defaultSalePrice}
            >
              <Input
                id={`price-${productId}`}
                name="defaultSalePrice"
                type="number"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                disabled={pricePending}
                required
              />
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={pricePending}
              >
                Cancel
              </Button>
              <SubmitButton pending={pricePending}>Save price</SubmitButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <form action={toggleAction}>
        <input type="hidden" name="id" value={productId} />
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          disabled={togglePending}
          title={
            isActive
              ? hasHistory
                ? "Retire: hides it from the batch and sale pickers, keeps all history"
                : "Retire: hides it from the batch and sale pickers"
              : "Make this product selectable again"
          }
        >
          {isActive ? "Retire" : "Restore"}
        </Button>
      </form>
    </div>
  );
}
