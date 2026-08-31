"use client";

import { Field, ReadOnlyField } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValueLabel,
} from "@/components/ui/select";
import { money } from "@/lib/format";
import type { CascadeResult, CascadeSelection } from "@/components/forms/product-cascade";

/**
 * The four cascading dropdowns plus the two read-only fields they populate.
 * Purely presentational - the parent form owns the selection state and hands in
 * the resolved cascade, so the picker cannot get out of step with the form.
 */
export function ProductPicker({
  resolved,
  onChange,
  error,
  disabled,
}: {
  resolved: CascadeResult;
  onChange: (patch: Partial<CascadeSelection>) => void;
  error?: string;
  disabled?: boolean;
}) {
  const { product } = resolved;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Category" htmlFor="pick-category" required>
          <Select
            value={resolved.categoryId == null ? "" : String(resolved.categoryId)}
            disabled={disabled}
            onValueChange={(v) =>
              // Changing a level clears everything below it; the cascade drops
              // any deeper value that is no longer valid anyway.
              onChange({
                categoryId: Number.parseInt(v, 10),
                name: null,
                packagingType: null,
                variantValue: null,
              })
            }
          >
            <SelectTrigger id="pick-category">
              <SelectValueLabel
                label={
                  resolved.categoryOptions.find((c) => c.id === resolved.categoryId)?.name
                }
                placeholder="Select a category"
              />
            </SelectTrigger>
            <SelectContent>
              {resolved.categoryOptions.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Product name" htmlFor="pick-name" required>
          <Select
            value={resolved.name ?? ""}
            disabled={disabled || resolved.nameOptions.length === 0}
            onValueChange={(v) => onChange({ name: v, packagingType: null, variantValue: null })}
          >
            <SelectTrigger id="pick-name">
              <SelectValueLabel
                label={resolved.name}
                placeholder={
                  resolved.categoryId == null ? "Pick a category first" : "Select a product"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {resolved.nameOptions.map((n) => (
                <SelectItem key={n} value={n}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Packaging type" htmlFor="pick-packaging" required>
          <Select
            value={resolved.packagingType ?? ""}
            disabled={disabled || resolved.packagingOptions.length === 0}
            onValueChange={(v) => onChange({ packagingType: v, variantValue: null })}
          >
            <SelectTrigger id="pick-packaging">
              <SelectValueLabel
                label={resolved.packagingType}
                placeholder={resolved.name == null ? "Pick a product first" : "Select packaging"}
              />
            </SelectTrigger>
            <SelectContent>
              {resolved.packagingOptions.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          label="Volume / variant"
          htmlFor="pick-variant"
          required
          error={error}
        >
          <Select
            value={resolved.variantValue ?? ""}
            disabled={disabled || resolved.variantOptions.length === 0}
            onValueChange={(v) => onChange({ variantValue: v })}
          >
            <SelectTrigger id="pick-variant" aria-invalid={error ? true : undefined}>
              <SelectValueLabel
                label={resolved.variantValue}
                placeholder={
                  resolved.packagingType == null ? "Pick packaging first" : "Select a volume"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {resolved.variantOptions.map((v) => (
                <SelectItem key={v} value={v}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <ReadOnlyField label="SKU" value={product?.sku ?? ""} mono />
        <ReadOnlyField
          label="Default sale price"
          value={product ? money(product.defaultSalePrice) : ""}
        />
        <ReadOnlyField label="Unit" value={product?.unit ?? ""} />
      </div>

      {/* The resolved product id is what the server action actually reads. */}
      <input type="hidden" name="productId" value={product?.id ?? ""} />
    </div>
  );
}
