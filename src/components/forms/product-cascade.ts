import type { ProductOption } from "@/lib/queries";

export type CascadeSelection = {
  categoryId: number | null;
  name: string | null;
  packagingType: string | null;
  variantValue: string | null;
};

export const EMPTY_SELECTION: CascadeSelection = {
  categoryId: null,
  name: null,
  packagingType: null,
  variantValue: null,
};

export type CascadeResult = CascadeSelection & {
  categoryOptions: { id: number; name: string }[];
  nameOptions: string[];
  packagingOptions: string[];
  variantOptions: string[];
  product: ProductOption | null;
};

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Resolves Category > Name > Packaging > Volume in one pure pass.
 *
 * Deriving the whole cascade from the raw selection on every render (instead of
 * syncing four pieces of state with effects) means a stale deeper choice can
 * never survive a change higher up: if the selected packaging is not valid for
 * the newly chosen flavor it simply is not in packagingOptions, so it is dropped.
 *
 * Levels with exactly one option are auto-selected - which is what makes the
 * Chocolate path a two-click affair today and keeps working unchanged when more
 * chocolate sizes are added later.
 */
export function cascade(products: ProductOption[], selection: CascadeSelection): CascadeResult {
  const categoryOptions = [
    ...new Map(products.map((p) => [p.categoryId, { id: p.categoryId, name: p.categoryName }])).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const categoryId =
    selection.categoryId != null && categoryOptions.some((c) => c.id === selection.categoryId)
      ? selection.categoryId
      : categoryOptions.length === 1
        ? categoryOptions[0].id
        : null;

  const inCategory = categoryId == null ? [] : products.filter((p) => p.categoryId === categoryId);
  const nameOptions = uniqueStrings(inCategory.map((p) => p.name)).sort((a, b) => a.localeCompare(b));

  const name =
    selection.name && nameOptions.includes(selection.name)
      ? selection.name
      : nameOptions.length === 1
        ? nameOptions[0]
        : null;

  const inName = name == null ? [] : inCategory.filter((p) => p.name === name);
  const packagingOptions = uniqueStrings(inName.map((p) => p.packagingType)).sort((a, b) =>
    a.localeCompare(b),
  );

  const packagingType =
    selection.packagingType && packagingOptions.includes(selection.packagingType)
      ? selection.packagingType
      : packagingOptions.length === 1
        ? packagingOptions[0]
        : null;

  const inPackaging =
    packagingType == null ? [] : inName.filter((p) => p.packagingType === packagingType);
  const variantOptions = uniqueStrings(inPackaging.map((p) => p.variantValue)).sort(
    (a, b) => volumeOrder(a) - volumeOrder(b),
  );

  const variantValue =
    selection.variantValue && variantOptions.includes(selection.variantValue)
      ? selection.variantValue
      : variantOptions.length === 1
        ? variantOptions[0]
        : null;

  const product =
    variantValue == null ? null : (inPackaging.find((p) => p.variantValue === variantValue) ?? null);

  return {
    categoryId,
    name,
    packagingType,
    variantValue,
    categoryOptions,
    nameOptions,
    packagingOptions,
    variantOptions,
    product,
  };
}

/** 250ml before 500ml before 1000ml, rather than alphabetical. */
function volumeOrder(label: string): number {
  const match = /^([\d.]+)/.exec(label.trim());
  if (!match) return Number.MAX_SAFE_INTEGER;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}
