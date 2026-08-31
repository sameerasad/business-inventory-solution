"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";

import { createProductAction } from "@/actions/products";
import { deriveSku, emptyActionState } from "@/lib/validations";
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
import { Field, ReadOnlyField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValueLabel,
} from "@/components/ui/select";
import { SubmitButton } from "@/components/forms/form-bits";

/**
 * How new catalog entries get added - the 20g chocolate bar, a sixth flavor, a
 * 2L bottle. Existing packaging types, volumes and units are offered as
 * suggestions so the catalog does not sprout "Bottle" and "bottle" as two
 * different packaging types.
 */
export function AddProductDialog({
  categories,
  packagingTypes,
  variantValues,
  units,
}: {
  categories: { id: number; name: string }[];
  packagingTypes: string[];
  variantValues: string[];
  units: string[];
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(createProductAction, emptyActionState);

  const [categoryId, setCategoryId] = useState("");
  const [name, setName] = useState("");
  const [packagingType, setPackagingType] = useState("");
  const [variantValue, setVariantValue] = useState("");
  const [unit, setUnit] = useState("");
  const [sku, setSku] = useState("");
  const [price, setPrice] = useState("");

  const previewSku = useMemo(() => {
    if (sku.trim()) return sku.trim().toUpperCase();
    if (!name.trim() || !packagingType.trim() || !variantValue.trim()) return "";
    return deriveSku({ name, packagingType, variantValue });
  }, [sku, name, packagingType, variantValue]);

  useEffect(() => {
    if (state.ok) {
      setName("");
      setPackagingType("");
      setVariantValue("");
      setUnit("");
      setSku("");
      setPrice("");
      setOpen(false);
    }
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button type="button" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
        Add product
      </Button>

      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a product</DialogTitle>
          <DialogDescription>
            A product is a unique combination of category, name, packaging and volume.
          </DialogDescription>
        </DialogHeader>

        {state.message && !state.ok ? <Alert tone="error">{state.message}</Alert> : null}

        <form action={formAction} className="space-y-4">
          <input type="hidden" name="categoryId" value={categoryId} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category" htmlFor="p-category" required error={state.fieldErrors.categoryId}>
              <Select value={categoryId} onValueChange={setCategoryId} disabled={isPending}>
                <SelectTrigger id="p-category">
                  <SelectValueLabel
                    label={categories.find((c) => String(c.id) === categoryId)?.name}
                    placeholder="Select a category"
                  />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Product name" htmlFor="p-name" required error={state.fieldErrors.name}>
              <Input
                id="p-name"
                name="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Guava Juice"
                disabled={isPending}
                required
              />
            </Field>

            <Field
              label="Packaging type"
              htmlFor="p-packaging"
              required
              error={state.fieldErrors.packagingType}
              hint={packagingTypes.length ? `In use: ${packagingTypes.join(", ")}` : undefined}
            >
              <Input
                id="p-packaging"
                name="packagingType"
                list="packaging-suggestions"
                value={packagingType}
                onChange={(e) => setPackagingType(e.target.value)}
                placeholder="e.g. Bar"
                disabled={isPending}
                required
              />
              <datalist id="packaging-suggestions">
                {packagingTypes.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </Field>

            <Field
              label="Volume / variant"
              htmlFor="p-variant"
              required
              error={state.fieldErrors.variantValue}
              hint={variantValues.length ? `In use: ${variantValues.join(", ")}` : undefined}
            >
              <Input
                id="p-variant"
                name="variantValue"
                list="variant-suggestions"
                value={variantValue}
                onChange={(e) => setVariantValue(e.target.value)}
                placeholder="e.g. 20g"
                disabled={isPending}
                required
              />
              <datalist id="variant-suggestions">
                {variantValues.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </Field>

            <Field
              label="Unit"
              htmlFor="p-unit"
              required
              error={state.fieldErrors.unit}
              hint={units.length ? `In use: ${units.join(", ")}` : undefined}
            >
              <Input
                id="p-unit"
                name="unit"
                list="unit-suggestions"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="e.g. bar"
                disabled={isPending}
                required
              />
              <datalist id="unit-suggestions">
                {units.map((u) => (
                  <option key={u} value={u} />
                ))}
              </datalist>
            </Field>

            <Field
              label="Default sale price"
              htmlFor="p-price"
              required
              error={state.fieldErrors.defaultSalePrice}
            >
              <Input
                id="p-price"
                name="defaultSalePrice"
                type="number"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0.00"
                disabled={isPending}
                required
              />
            </Field>

            <Field
              label="SKU"
              htmlFor="p-sku"
              error={state.fieldErrors.sku}
              hint="Leave blank to generate one."
            >
              <Input
                id="p-sku"
                name="sku"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                placeholder="Auto"
                className="font-mono"
                disabled={isPending}
              />
            </Field>

            <ReadOnlyField label="SKU preview" value={previewSku} mono />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <SubmitButton pending={isPending} disabled={!categoryId}>
              Add product
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
