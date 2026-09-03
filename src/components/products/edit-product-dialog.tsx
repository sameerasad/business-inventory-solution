"use client";

import { useState } from "react";

import { updateProductAction } from "@/actions/products";
import { EditDialog } from "@/components/forms/edit-dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type EditableProduct = {
  id: number;
  sku: string;
  name: string;
  categoryId: number;
  packagingType: string;
  variantValue: string;
  unit: string;
  defaultSalePrice: number;
};

/**
 * The full catalog edit: category, name, packaging, variant, SKU, unit, price.
 *
 * None of it disturbs history. A sale keeps the price it was sold at and takes
 * its cost from its batch, so correcting a name or a packaging label relabels
 * the product everywhere without moving a single figure.
 *
 * The SKU is editable but cannot be blanked. Leaving it empty means "derive one
 * for me" when creating a product; doing that on an edit would silently rename
 * a code that is already on paperwork.
 */
export function EditProductDialog({
  product,
  categories,
  packagingTypes,
  variantValues,
  units,
}: {
  product: EditableProduct;
  categories: { id: number; name: string }[];
  packagingTypes: string[];
  variantValues: string[];
  units: string[];
}) {
  const [categoryId, setCategoryId] = useState(String(product.categoryId));

  const listId = `sug-${product.id}`;

  return (
    <EditDialog
      action={updateProductAction}
      title={`Edit ${product.sku}`}
      description="Changes apply everywhere this product appears. Recorded sales keep their own price and cost, so no past figure moves."
      triggerLabel="Edit"
      formKey={`${product.id}-${product.sku}-${product.defaultSalePrice}`}
      footerNote="Retiring is on the row beside this. Retire when a product is discontinued; edit when the details were wrong."
    >
      {(state, isPending) => (
        <>
          <input type="hidden" name="id" value={product.id} />
          <input type="hidden" name="categoryId" value={categoryId} />

          <datalist id={`${listId}-pack`}>
            {packagingTypes.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <datalist id={`${listId}-variant`}>
            {variantValues.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <datalist id={`${listId}-unit`}>
            {units.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category" required error={state.fieldErrors.categoryId}>
              <Select value={categoryId} onValueChange={setCategoryId} disabled={isPending}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a category" />
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

            <Field
              label="Product name"
              htmlFor={`p-name-${product.id}`}
              required
              error={state.fieldErrors.name}
            >
              <Input
                id={`p-name-${product.id}`}
                name="name"
                defaultValue={product.name}
                disabled={isPending}
                required
              />
            </Field>

            <Field
              label="Packaging"
              htmlFor={`p-pack-${product.id}`}
              required
              error={state.fieldErrors.packagingType}
            >
              <Input
                id={`p-pack-${product.id}`}
                name="packagingType"
                list={`${listId}-pack`}
                defaultValue={product.packagingType}
                disabled={isPending}
                required
              />
            </Field>

            <Field
              label="Variant / volume"
              htmlFor={`p-var-${product.id}`}
              required
              error={state.fieldErrors.variantValue}
            >
              <Input
                id={`p-var-${product.id}`}
                name="variantValue"
                list={`${listId}-variant`}
                defaultValue={product.variantValue}
                disabled={isPending}
                required
              />
            </Field>

            <Field
              label="SKU"
              htmlFor={`p-sku-${product.id}`}
              required
              error={state.fieldErrors.sku}
              hint="Letters, digits and dashes."
            >
              <Input
                id={`p-sku-${product.id}`}
                name="sku"
                defaultValue={product.sku}
                className="font-mono"
                disabled={isPending}
                required
              />
            </Field>

            <Field
              label="Unit"
              htmlFor={`p-unit-${product.id}`}
              required
              error={state.fieldErrors.unit}
              hint="How stock is counted. Invoices always bill in packs."
            >
              <Input
                id={`p-unit-${product.id}`}
                name="unit"
                list={`${listId}-unit`}
                defaultValue={product.unit}
                disabled={isPending}
                required
              />
            </Field>
          </div>

          <Field
            label="Default sale price"
            htmlFor={`p-price-${product.id}`}
            required
            error={state.fieldErrors.defaultSalePrice}
            hint="Pre-fills the sale and booking forms only."
          >
            <Input
              id={`p-price-${product.id}`}
              name="defaultSalePrice"
              type="number"
              min={0}
              step="0.01"
              defaultValue={product.defaultSalePrice.toFixed(2)}
              disabled={isPending}
              required
            />
          </Field>
        </>
      )}
    </EditDialog>
  );
}
