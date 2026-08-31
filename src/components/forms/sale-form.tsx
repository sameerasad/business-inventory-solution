"use client";

import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

import { createSaleAction, fetchAvailableBatches } from "@/actions/sales";
import { emptyActionState } from "@/lib/validations";
import type { AvailableBatch, ProductOption } from "@/lib/queries";
import { dateOnly, money, todayInputValue } from "@/lib/format";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValueLabel,
} from "@/components/ui/select";
import { AddShopDialog } from "@/components/forms/add-shop-dialog";
import { ProductPicker } from "@/components/forms/product-picker";
import { SubmitButton, useIdempotencyKey } from "@/components/forms/form-bits";
import {
  cascade,
  EMPTY_SELECTION,
  type CascadeSelection,
} from "@/components/forms/product-cascade";

export type AreaOption = { id: number; name: string; shops: { id: number; name: string }[] };

/** Same string in the dropdown and in the closed trigger. */
function describeBatch(b: AvailableBatch): string {
  return `Batch #${b.id} | Received: ${dateOnly(b.receivedDate)} | Remaining: ${b.remainingQty} | Unit Cost: ${money(b.unitCost)}`;
}

const NO_SHOP = "none";

/**
 * Inventory OUT. The sale must name the batch it draws from, because the batch is
 * what carries the unit cost that profit is calculated against.
 */
export function SaleForm({
  products,
  areas,
}: {
  products: ProductOption[];
  areas: AreaOption[];
}) {
  const [state, formAction, isPending] = useActionState(createSaleAction, emptyActionState);
  const { key: idempotencyKey, rotate } = useIdempotencyKey();

  const [selection, setSelection] = useState<CascadeSelection>(EMPTY_SELECTION);
  const [batches, setBatches] = useState<AvailableBatch[]>([]);
  const [batchesLoading, startBatchLoad] = useTransition();
  const [batchId, setBatchId] = useState<string>("");
  const [quantity, setQuantity] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [areaId, setAreaId] = useState<string>("");
  const [shopId, setShopId] = useState<string>(NO_SHOP);
  const [saleDate, setSaleDate] = useState(todayInputValue);
  const [notes, setNotes] = useState("");
  /** Shops created from the dialog, so the picker updates without a page reload. */
  const [addedShops, setAddedShops] = useState<{ id: number; name: string; areaId: number }[]>([]);

  const resolved = useMemo(() => cascade(products, selection), [products, selection]);
  const product = resolved.product;
  const productId = product?.id ?? null;

  // Batches belong to a product, so the list is refetched whenever the product
  // changes. Fetching on demand (rather than shipping every batch to the client)
  // keeps this page small no matter how much history accumulates.
  const loadedForProduct = useRef<number | null>(null);
  useEffect(() => {
    if (productId == null) {
      loadedForProduct.current = null;
      setBatches([]);
      setBatchId("");
      return;
    }
    if (loadedForProduct.current === productId) return;
    loadedForProduct.current = productId;
    setBatchId("");
    startBatchLoad(async () => {
      const rows = await fetchAvailableBatches(productId);
      // Guard against an out-of-order response from a fast double change.
      if (loadedForProduct.current !== productId) return;
      setBatches(rows);
      // Default to the oldest batch with stock: FIFO by default, still editable.
      setBatchId(rows.length > 0 ? String(rows[0].id) : "");
    });
  }, [productId]);

  // Sale price pre-fills from the catalog default and stays editable.
  const pricedForProduct = useRef<number | null>(null);
  useEffect(() => {
    if (product == null) {
      pricedForProduct.current = null;
      setSalePrice("");
      return;
    }
    if (pricedForProduct.current === product.id) return;
    pricedForProduct.current = product.id;
    setSalePrice(product.defaultSalePrice.toFixed(2));
  }, [product]);

  useEffect(() => {
    if (state.ok) {
      setQuantity("");
      setNotes("");
      rotate();
      // Stock changed, so the remaining quantities on screen are now stale.
      if (productId != null) {
        startBatchLoad(async () => {
          const rows = await fetchAvailableBatches(productId);
          setBatches(rows);
          setBatchId((current) =>
            rows.some((r) => String(r.id) === current)
              ? current
              : rows.length > 0
                ? String(rows[0].id)
                : "",
          );
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const selectedArea = areas.find((a) => String(a.id) === areaId) ?? null;
  const shopOptions = useMemo(() => {
    if (!selectedArea) return [];
    const extra = addedShops
      .filter((s) => s.areaId === selectedArea.id)
      .filter((s) => !selectedArea.shops.some((existing) => existing.id === s.id))
      .map((s) => ({ id: s.id, name: s.name }));
    return [...selectedArea.shops, ...extra].sort((a, b) => a.name.localeCompare(b.name));
  }, [selectedArea, addedShops]);

  const selectedBatch = batches.find((b) => String(b.id) === batchId) ?? null;
  const qtyNum = Number.parseInt(quantity, 10);
  const priceNum = Number.parseFloat(salePrice);

  const overStock =
    selectedBatch != null && Number.isFinite(qtyNum) && qtyNum > selectedBatch.remainingQty;

  const preview =
    selectedBatch != null && Number.isFinite(qtyNum) && qtyNum > 0 && Number.isFinite(priceNum)
      ? {
          revenue: priceNum * qtyNum,
          profit: (priceNum - selectedBatch.unitCost) * qtyNum,
          remainingAfter: selectedBatch.remainingQty - qtyNum,
        }
      : null;

  const canSubmit =
    product != null && selectedBatch != null && areaId !== "" && !overStock && !batchesLoading;

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="batchId" value={batchId} />
      <input type="hidden" name="areaId" value={areaId} />
      <input type="hidden" name="shopId" value={shopId === NO_SHOP ? "" : shopId} />

      {state.message ? (
        <Alert tone={state.ok ? "success" : "error"}>
          {state.message}
          {state.ok ? (
            <>
              {" "}
              <Link href="/sales" className="font-medium underline">
                View all sales
              </Link>
            </>
          ) : null}
        </Alert>
      ) : null}

      {/* ------------------------------------------------------------ product */}
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

      {/* -------------------------------------------------------------- batch */}
      <Card>
        <CardContent className="space-y-5 p-5">
          <Field
            label="Batch to sell from"
            htmlFor="batch"
            required
            error={state.fieldErrors.batchId}
            hint={
              product == null
                ? "Pick a product first."
                : "Only batches with stock remaining are listed. Oldest first."
            }
          >
            <div className="flex items-center gap-2">
              <Select
                value={batchId}
                disabled={isPending || product == null || batches.length === 0}
                onValueChange={setBatchId}
              >
                <SelectTrigger id="batch" aria-invalid={state.fieldErrors.batchId ? true : undefined}>
                  <SelectValueLabel
                    label={selectedBatch ? describeBatch(selectedBatch) : undefined}
                    placeholder={
                      product == null
                        ? "Pick a product first"
                        : batchesLoading
                          ? "Loading batches..."
                          : batches.length === 0
                            ? "No stock available for this product"
                            : "Select a batch"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {batches.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)}>
                      {describeBatch(b)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {batchesLoading ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              ) : null}
            </div>
          </Field>

          {product != null && !batchesLoading && batches.length === 0 ? (
            <Alert tone="info">
              {product.sku} has no stock left.{" "}
              <Link href="/batches/new" className="font-medium underline">
                Receive a batch
              </Link>{" "}
              before recording a sale.
            </Alert>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Quantity"
              htmlFor="quantity"
              required
              error={
                state.fieldErrors.quantity ??
                (overStock && selectedBatch
                  ? `Only ${selectedBatch.remainingQty} left in batch #${selectedBatch.id}`
                  : undefined)
              }
              hint={
                selectedBatch ? `Up to ${selectedBatch.remainingQty} available` : undefined
              }
            >
              <Input
                id="quantity"
                name="quantity"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                max={selectedBatch?.remainingQty}
                placeholder="0"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                aria-invalid={overStock || state.fieldErrors.quantity ? true : undefined}
                disabled={isPending || selectedBatch == null}
                required
              />
            </Field>

            <Field
              label="Sale price"
              htmlFor="salePrice"
              required
              error={state.fieldErrors.salePrice}
              hint="Per unit. Pre-filled from the catalog default."
            >
              <Input
                id="salePrice"
                name="salePrice"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                placeholder="0.00"
                value={salePrice}
                onChange={(e) => setSalePrice(e.target.value)}
                aria-invalid={state.fieldErrors.salePrice ? true : undefined}
                disabled={isPending || product == null}
                required
              />
            </Field>

            <Field
              label="Sale date"
              htmlFor="saleDate"
              required
              error={state.fieldErrors.saleDate}
            >
              <Input
                id="saleDate"
                name="saleDate"
                type="date"
                value={saleDate}
                onChange={(e) => setSaleDate(e.target.value)}
                aria-invalid={state.fieldErrors.saleDate ? true : undefined}
                disabled={isPending}
                required
              />
            </Field>
          </div>

          {preview ? (
            <div className="flex flex-wrap items-center gap-x-8 gap-y-1 rounded-md bg-muted px-3 py-2.5 text-sm">
              <span className="text-muted-foreground">
                Revenue <strong className="num text-foreground">{money(preview.revenue)}</strong>
              </span>
              <span className="text-muted-foreground">
                Profit{" "}
                <strong
                  className="num"
                  style={{ color: preview.profit < 0 ? "#d03b3b" : "#006300" }}
                >
                  {money(preview.profit)}
                </strong>
              </span>
              {preview.remainingAfter >= 0 ? (
                <span className="text-muted-foreground">
                  Batch left after{" "}
                  <strong className="num text-foreground">{preview.remainingAfter}</strong>
                  {preview.remainingAfter === 0 ? (
                    <Badge variant="secondary" className="ml-2">
                      Batch will be depleted
                    </Badge>
                  ) : null}
                </span>
              ) : null}
              <span className="text-xs text-muted-foreground">
                Preview only. The server recalculates from the stored batch cost.
              </span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* ----------------------------------------------------- where it sold */}
      <Card>
        <CardContent className="space-y-5 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Area" htmlFor="area" required error={state.fieldErrors.areaId}>
              <Select
                value={areaId}
                disabled={isPending}
                onValueChange={(v) => {
                  setAreaId(v);
                  // A shop from the previous area would be rejected server-side.
                  setShopId(NO_SHOP);
                }}
              >
                <SelectTrigger id="area" aria-invalid={state.fieldErrors.areaId ? true : undefined}>
                  <SelectValueLabel label={selectedArea?.name} placeholder="Select an area" />
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

            <Field
              label="Shop"
              htmlFor="shop"
              error={state.fieldErrors.shopId}
              hint={
                selectedArea == null
                  ? "Pick an area first."
                  : "Leave as Direct Sale if this was not through a shop."
              }
            >
              <div className="flex items-center gap-2">
                <Select
                  value={shopId}
                  disabled={isPending || selectedArea == null}
                  onValueChange={setShopId}
                >
                  <SelectTrigger
                    id="shop"
                    aria-invalid={state.fieldErrors.shopId ? true : undefined}
                  >
                    <SelectValueLabel
                      label={
                        shopId === NO_SHOP
                          ? "Direct Sale / No Shop"
                          : shopOptions.find((s) => String(s.id) === shopId)?.name
                      }
                      placeholder="Direct Sale / No Shop"
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_SHOP}>Direct Sale / No Shop</SelectItem>
                    {shopOptions.map((s) => (
                      <SelectItem key={s.id} value={String(s.id)}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <AddShopDialog
                  areaId={selectedArea?.id ?? null}
                  areaName={selectedArea?.name ?? null}
                  onCreated={(shop) => {
                    setAddedShops((prev) => [...prev, shop]);
                    setShopId(String(shop.id));
                  }}
                />
              </div>
            </Field>
          </div>

          <Field label="Notes" htmlFor="notes" error={state.fieldErrors.notes}>
            <Textarea
              id="notes"
              name="notes"
              placeholder="Order reference, buyer name, delivery detail."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={isPending}
            />
          </Field>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <SubmitButton pending={isPending} disabled={!canSubmit} pendingLabel="Recording...">
          Record sale
        </SubmitButton>
        <Button type="button" variant="outline" asChild>
          <Link href="/sales">Cancel</Link>
        </Button>
      </div>
    </form>
  );
}
