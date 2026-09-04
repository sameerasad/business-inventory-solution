"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Download, Plus, Trash2 } from "lucide-react";

import { createBookingAction } from "@/actions/bookings";
import { emptyActionState } from "@/lib/validations";
import type { BookableProduct } from "@/lib/bookings";
import { money, todayInputValue } from "@/lib/format";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AddShopDialog } from "@/components/forms/add-shop-dialog";
import { BookingDictate, type DictatedBooking } from "@/components/forms/booking-dictate";
import { SubmitButton, useIdempotencyKey } from "@/components/forms/form-bits";
import type { AreaOption } from "@/components/forms/sale-form";

const NO_SHOP = "none";

type Line = {
  /** Local-only row id, so removing a row never reshuffles React keys. */
  key: string;
  productId: string;
  quantity: string;
  unitPrice: string;
};

let lineSeq = 0;
function blankLine(): Line {
  lineSeq += 1;
  return { key: `line-${lineSeq}`, productId: "", quantity: "", unitPrice: "" };
}

/**
 * The booker's order form.
 *
 * Unlike the New Sale form there is no batch picker: the server allocates stock
 * oldest-batch-first and splits a line across batches when it has to. The booker
 * only needs to know what was ordered and at what price.
 */
export function BookingForm({
  products,
  areas,
  bookers,
  whisperAvailable = false,
}: {
  products: BookableProduct[];
  areas: AreaOption[];
  bookers: { id: number; name: string; code: string | null; areaIds: number[] }[];
  /** Whether the server can transcribe with Whisper, for the voice filler. */
  whisperAvailable?: boolean;
}) {
  const [state, formAction, isPending] = useActionState(createBookingAction, emptyActionState);
  const { key: idempotencyKey, rotate } = useIdempotencyKey();

  // Remembered per browser: a booker enters order after order as themselves,
  // so re-picking their own name every time is pure friction.
  const [bookerId, setBookerId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [areaId, setAreaId] = useState("");
  const [shopId, setShopId] = useState(NO_SHOP);
  const [bookingDate, setBookingDate] = useState(todayInputValue);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>(() => [blankLine()]);
  const [addedShops, setAddedShops] = useState<
    { id: number; name: string; address: string | null; phone: string | null; areaId: number }[]
  >([]);

  const byId = useMemo(() => new Map(products.map((p) => [String(p.id), p])), [products]);

  /**
   * Writes a dictated order into the form's own state.
   *
   * Into the real fields, not a separate preview: that is the whole point of
   * doing this here rather than on the Voice page. A misheard quantity is then
   * a number on screen that can be corrected with the keyboard, instead of a
   * reason to say the entire order again.
   */
  const applyDictated = (command: DictatedBooking) => {
    setBookingDate(command.date);
    setBookerId(command.bookerId == null ? "" : String(command.bookerId));
    setCustomerPhone(command.customerPhone ?? "");
    setAreaId(command.areaId == null ? "" : String(command.areaId));
    setShopId(command.shopId == null ? NO_SHOP : String(command.shopId));
    setLines(
      command.lines.length === 0
        ? [blankLine()]
        : command.lines.map((line, index) => ({
            key: `dictated-${index}-${line.productId}`,
            productId: String(line.productId),
            // Empty, not "0", when no quantity was said. A zero looks like an
            // answer and has to be deleted before it can be corrected; an
            // empty required field asks the question by itself, and the
            // browser will not let the form save until it is answered.
            quantity: line.quantity > 0 ? String(line.quantity) : "",
            unitPrice: String(line.unitPrice),
          })),
    );
  };

  useEffect(() => {
    if (state.ok) {
      // A booker takes one order after another; clear the order but keep the
      // area so the next entry is quicker.
      // bookerId deliberately survives: the same person takes the next order.
      setCustomerName("");
      setCustomerPhone("");
      setNotes("");
      setShopId(NO_SHOP);
      setLines([blankLine()]);
      rotate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const selectedBooker = bookers.find((b) => String(b.id) === bookerId) ?? null;
  const selectedArea = areas.find((a) => String(a.id) === areaId) ?? null;

  // Territory is advisory: covering for someone off sick is normal, so an
  // out-of-territory order is flagged rather than blocked. It only means
  // anything once the booker actually has areas assigned.
  const offTerritory =
    selectedBooker != null &&
    selectedBooker.areaIds.length > 0 &&
    selectedArea != null &&
    !selectedBooker.areaIds.includes(selectedArea.id);
  const territoryNames =
    selectedBooker == null
      ? []
      : areas.filter((a) => selectedBooker.areaIds.includes(a.id)).map((a) => a.name);
  const shopOptions = useMemo(() => {
    if (!selectedArea) return [];
    const extra = addedShops
      .filter((s) => s.areaId === selectedArea.id)
      .filter((s) => !selectedArea.shops.some((e) => e.id === s.id))
      .map((s) => ({ id: s.id, name: s.name, address: s.address, phone: s.phone }));
    return [...selectedArea.shops, ...extra].sort((a, b) => a.name.localeCompare(b.name));
  }, [selectedArea, addedShops]);

  // The shop the booker picked, so its stored address can be shown read-only.
  const selectedShop = shopOptions.find((s) => String(s.id) === shopId) ?? null;

  const patchLine = (key: string, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const computed = lines.map((line) => {
    const product = byId.get(line.productId) ?? null;
    const q = Number.parseInt(line.quantity, 10);
    const price = Number.parseFloat(line.unitPrice);
    const quantity = Number.isFinite(q) && q > 0 ? q : 0;
    const validPrice = Number.isFinite(price) && price >= 0 ? price : null;
    return {
      line,
      product,
      quantity,
      unitPrice: validPrice,
      lineTotal: product && quantity && validPrice != null ? quantity * validPrice : null,
      overStock: product != null && quantity > product.available,
      complete: product != null && quantity > 0 && validPrice != null,
    };
  });

  // Two rows for the same product each draw from the same pool, so availability
  // has to be checked against the combined quantity, not per row.
  const perProduct = new Map<string, number>();
  for (const row of computed) {
    if (row.product && row.quantity > 0) {
      perProduct.set(row.line.productId, (perProduct.get(row.line.productId) ?? 0) + row.quantity);
    }
  }
  const combinedOverStock = [...perProduct.entries()]
    .map(([pid, total]) => ({ product: byId.get(pid)!, total }))
    .filter((x) => x.product && x.total > x.product.available);

  const orderTotal = computed.reduce((sum, r) => sum + (r.lineTotal ?? 0), 0);
  const orderUnits = computed.reduce((sum, r) => sum + r.quantity, 0);
  const filledLines = computed.filter((r) => r.complete);

  const canSubmit =
    !isPending &&
    areaId !== "" &&
    filledLines.length > 0 &&
    filledLines.length === lines.length &&
    combinedOverStock.length === 0;

  // Only complete lines are sent; the server re-validates and merges duplicates.
  const linesPayload = JSON.stringify(
    filledLines.map((r) => ({
      productId: r.product!.id,
      quantity: r.quantity,
      unitPrice: r.unitPrice!,
    })),
  );

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="areaId" value={areaId} />
      <input type="hidden" name="bookerId" value={bookerId} />
      <input type="hidden" name="shopId" value={shopId === NO_SHOP ? "" : shopId} />
      <input type="hidden" name="lines" value={linesPayload} />

      {state.message ? (
        <Alert tone={state.ok ? "success" : "error"}>
          {state.message}
          {state.ok ? (
            <>
              {" "}
              <Link href="/bookings" className="font-medium underline">
                View bookings and download the invoice
              </Link>
            </>
          ) : null}
        </Alert>
      ) : null}

      {/* ------------------------------------------------ who and when */}
      <Card>
        <CardHeader className="flex flex-col gap-3">
          <div className="flex flex-col gap-3">
            <CardTitle>Customer &amp; date</CardTitle>
            <BookingDictate whisperAvailable={whisperAvailable} onFilled={applyDictated} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Booking date"
              htmlFor="bookingDate"
              required
              error={state.fieldErrors.bookingDate}
              hint="The sales are recorded on this date."
            >
              <Input
                id="bookingDate"
                name="bookingDate"
                type="date"
                value={bookingDate}
                onChange={(e) => setBookingDate(e.target.value)}
                disabled={isPending}
                required
              />
            </Field>

            <Field
              label="Booker"
              htmlFor="booker"
              error={state.fieldErrors.bookerId}
              hint={
                bookers.length === 0
                  ? "No bookers yet - add them on the Bookers page to track performance."
                  : territoryNames.length > 0
                    ? `Covers ${territoryNames.join(", ")}.`
                    : "Who took this order. Drives the Bookers report."
              }
            >
              <Select
                value={bookerId}
                disabled={isPending || bookers.length === 0}
                onValueChange={setBookerId}
              >
                <SelectTrigger id="booker">
                  <SelectValue
                    placeholder={bookers.length === 0 ? "No bookers added" : "Select a booker"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {bookers.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)}>
                      {b.code ? `${b.name} (${b.code})` : b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field
              label="Customer name"
              htmlFor="customerName"
              error={state.fieldErrors.customerName}
              hint="Optional. Blank prints as Walk-in customer."
            >
              <Input
                id="customerName"
                name="customerName"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Leave blank for a walk-in"
                aria-invalid={state.fieldErrors.customerName ? true : undefined}
                disabled={isPending}
              />
            </Field>

            <Field
              label="Customer phone"
              htmlFor="customerPhone"
              error={state.fieldErrors.customerPhone}
            >
              <Input
                id="customerPhone"
                name="customerPhone"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                placeholder="Optional"
                disabled={isPending}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Area"
              htmlFor="area"
              required
              error={state.fieldErrors.areaId}
              hint={
                offTerritory
                  ? `Outside ${selectedBooker!.name}'s areas. This still saves - it is reported as off-territory.`
                  : undefined
              }
            >
              <Select
                value={areaId}
                disabled={isPending}
                onValueChange={(v) => {
                  setAreaId(v);
                  setShopId(NO_SHOP);
                }}
              >
                <SelectTrigger id="area" aria-invalid={state.fieldErrors.areaId ? true : undefined}>
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

            <Field
              label="Shop"
              htmlFor="shop"
              error={state.fieldErrors.shopId}
              hint={selectedArea == null ? "Pick an area first." : undefined}
            >
              <div className="flex items-center gap-2">
                <Select
                  value={shopId}
                  disabled={isPending || selectedArea == null}
                  onValueChange={setShopId}
                >
                  <SelectTrigger id="shop">
                    <SelectValue placeholder="Direct Sale / No Shop" />
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
              {selectedShop ? (
                <p className="text-xs text-muted-foreground">
                  {selectedShop.address
                    ? `Delivery address: ${selectedShop.address}`
                    : "No address saved for this shop. Add one on Areas & Shops and it will print on future invoices."}
                </p>
              ) : null}
            </Field>
          </div>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------- order lines */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Order</CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setLines((prev) => [...prev, blankLine()])}
            disabled={isPending}
          >
            <Plus className="h-4 w-4" />
            Add line
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {state.fieldErrors.lines ? <Alert tone="error">{state.fieldErrors.lines}</Alert> : null}

          {combinedOverStock.length > 0 ? (
            <Alert tone="error">
              Not enough stock for{" "}
              {combinedOverStock
                .map((x) => `${x.product.sku} (want ${x.total}, have ${x.product.available})`)
                .join(", ")}
              .
            </Alert>
          ) : null}

          <div className="space-y-3">
            {computed.map((row, index) => (
              <div
                key={row.line.key}
                className="grid gap-3 rounded-md border p-3 sm:grid-cols-[minmax(0,1fr)_88px_112px_104px_auto] sm:items-end"
              >
                <Field label={`Product ${index + 1}`} htmlFor={`p-${row.line.key}`} required>
                  <Select
                    value={row.line.productId}
                    disabled={isPending}
                    onValueChange={(v) => {
                      const product = byId.get(v);
                      // Pre-fill the price from the catalog default, but only
                      // when the booker has not typed one already.
                      patchLine(row.line.key, {
                        productId: v,
                        unitPrice:
                          row.line.unitPrice === "" && product
                            ? String(product.defaultSalePrice)
                            : row.line.unitPrice,
                      });
                    }}
                  >
                    <SelectTrigger id={`p-${row.line.key}`}>
                      <SelectValue placeholder="Select a product" />
                    </SelectTrigger>
                    <SelectContent>
                      {products.map((p) => (
                        <SelectItem key={p.id} value={String(p.id)} disabled={p.available === 0}>
                          {`${p.sku} · ${p.name} ${p.packagingType} ${p.variantValue} — ${
                            p.available > 0 ? `${p.available} in stock` : "out of stock"
                          }`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label="Qty" htmlFor={`q-${row.line.key}`} required>
                  <Input
                    id={`q-${row.line.key}`}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    max={row.product?.available}
                    value={row.line.quantity}
                    onChange={(e) => patchLine(row.line.key, { quantity: e.target.value })}
                    aria-invalid={row.overStock ? true : undefined}
                    disabled={isPending}
                    placeholder="0"
                  />
                </Field>

                <Field label="Unit price" htmlFor={`u-${row.line.key}`} required>
                  <Input
                    id={`u-${row.line.key}`}
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={row.line.unitPrice}
                    onChange={(e) => patchLine(row.line.key, { unitPrice: e.target.value })}
                    disabled={isPending}
                    placeholder="0"
                  />
                </Field>

                <div className="space-y-1.5">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Line total
                  </span>
                  <div className="flex h-10 items-center justify-end rounded-md border border-dashed bg-muted px-3 text-sm">
                    <span className="num font-medium">
                      {row.lineTotal == null ? "—" : money(row.lineTotal)}
                    </span>
                  </div>
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="sm:mb-0.5"
                  aria-label={`Remove line ${index + 1}`}
                  disabled={isPending || lines.length === 1}
                  onClick={() => setLines((prev) => prev.filter((l) => l.key !== row.line.key))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-x-8 gap-y-1 rounded-md bg-muted px-4 py-3">
            <span className="text-sm text-muted-foreground">
              Lines <strong className="num text-foreground">{filledLines.length}</strong>
            </span>
            <span className="text-sm text-muted-foreground">
              Units <strong className="num text-foreground">{orderUnits}</strong>
            </span>
            <span className="text-sm text-muted-foreground">
              Order total{" "}
              <strong className="num text-base text-foreground">{money(orderTotal)}</strong>
            </span>
          </div>

          <Field label="Notes" htmlFor="notes" error={state.fieldErrors.notes}>
            <Textarea
              id="notes"
              name="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Delivery instructions, payment terms. Prints on the invoice."
              className="min-h-[56px]"
              disabled={isPending}
            />
          </Field>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={isPending} disabled={!canSubmit} pendingLabel="Booking...">
          <Download className="h-4 w-4" />
          Book order &amp; create invoice
        </SubmitButton>
        <Button type="button" variant="outline" asChild>
          <Link href="/bookings">Cancel</Link>
        </Button>
        {!canSubmit && !isPending ? (
          <p className="text-xs text-muted-foreground">
            {areaId === ""
              ? "Pick an area."
              : filledLines.length !== lines.length
                ? "Every line needs a product, quantity and price."
                : combinedOverStock.length > 0
                  ? "Reduce the quantities that exceed stock."
                  : "Add at least one product line."}
          </p>
        ) : null}
        <Badge variant="outline" className="ml-auto">
          Stock is deducted oldest batch first
        </Badge>
      </div>
    </form>
  );
}
