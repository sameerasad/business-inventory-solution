"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import type { VoiceCommand } from "@/lib/voice/parse";
import type { VoiceEditOptions } from "@/actions/voice";
import { createShop } from "@/actions/areas";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";

export type BookingCommand = Extract<VoiceCommand, { kind: "booking" }>;

/**
 * What is still missing from an order, worked out from what is on screen.
 *
 * The command arrives carrying a `missing` list from the interpreter, and that
 * list is a statement about the recording - it cannot know that somebody has
 * since picked the shop by hand. So once the order is editable, the gaps have
 * to be derived from the draft on every keystroke, or the Save button stays
 * locked against a field that has already been filled in.
 */
export function bookingGaps(order: BookingCommand): string[] {
  const gaps: string[] = [];
  if (order.lines.length === 0) gaps.push("product");
  else if (order.lines.some((l) => !(l.quantity > 0))) gaps.push("quantity");
  if (order.lines.some((l) => !(l.unitPrice > 0))) gaps.push("price");
  if (order.areaId == null) gaps.push("area");
  return gaps;
}

/**
 * Correct an order by hand, without saying it again.
 *
 * Voice gets the shop right far more often than it gets a quantity right, and
 * before this the only way to fix one wrong number was to cancel the whole
 * thing and repeat the sentence - which usually produced a different set of
 * mistakes. Everything here writes into the same command shape the interpreter
 * produced, so saving goes down the one path it always did and gains no
 * shortcut around validation.
 */
export function BookingEditor({
  order,
  options,
  disabled,
  onChange,
}: {
  order: BookingCommand;
  options: VoiceEditOptions;
  disabled?: boolean;
  onChange: (next: BookingCommand) => void;
}) {
  /**
   * Shops added from inside this panel.
   *
   * The option lists arrive as a prop, fetched once when the editor opened. A
   * shop created a moment ago is not in them, so without this the select it was
   * just assigned to would show nothing - the shop would be on the order and
   * invisible on screen, which is the worst of both.
   */
  const [added, setAdded] = useState<VoiceEditOptions["shops"]>([]);

  const productOptions = options.products.map((p) => ({ value: String(p.id), label: p.label }));
  const areaOptions = options.areas.map((a) => ({ value: String(a.id), label: a.name }));
  // Only shops in the chosen area: a shop belongs to one area, and offering all
  // fifty is how the wrong one gets picked.
  const shopOptions = [...options.shops, ...added]
    .filter((s) => order.areaId == null || s.areaId === order.areaId)
    .map((s) => ({ value: String(s.id), label: s.name }));
  const bookerOptions = options.bookers.map((b) => ({ value: String(b.id), label: b.name }));

  const setLine = (i: number, patch: Partial<BookingCommand["lines"][number]>) => {
    const lines = order.lines.map((l, n) => (n === i ? { ...l, ...patch } : l));
    onChange({ ...order, lines });
  };

  return (
    <div className="space-y-4 rounded-md border bg-muted/30 p-3">
      {/* --------------------------------------------------------- the lines */}
      <div className="space-y-3">
        {order.lines.map((line, i) => (
          <div key={i} className="space-y-2 rounded-md border bg-card p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {order.lines.length > 1 ? `Line ${i + 1}` : "Product"}
              </span>
              {order.lines.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  aria-label={`Remove line ${i + 1}`}
                  onClick={() => onChange({ ...order, lines: order.lines.filter((_, n) => n !== i) })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </div>

            <SearchableSelect
              value={line.productId > 0 ? String(line.productId) : ""}
              options={productOptions}
              includeAll={false}
              allLabel="Pick a product"
              disabled={disabled}
              onChange={(v) => {
                const picked = options.products.find((p) => String(p.id) === v);
                if (!picked) return;
                setLine(i, {
                  productId: picked.id,
                  label: picked.label,
                  // A price that was never heard takes the product's own, which
                  // is what a typed order would start from too. One that WAS
                  // heard is left alone - it may be a deliberate discount.
                  unitPrice: line.unitPrice > 0 ? line.unitPrice : picked.price,
                });
              }}
            />

            <div className="grid grid-cols-2 gap-2">
              <Field label="Quantity" htmlFor={`vq-${i}`} required>
                <Input
                  id={`vq-${i}`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={line.quantity > 0 ? String(line.quantity) : ""}
                  placeholder="0"
                  disabled={disabled}
                  onChange={(e) => setLine(i, { quantity: Number.parseInt(e.target.value, 10) || 0 })}
                />
              </Field>
              <Field label="Price each" htmlFor={`vp-${i}`} required>
                <Input
                  id={`vp-${i}`}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={line.unitPrice > 0 ? String(line.unitPrice) : ""}
                  placeholder="0"
                  disabled={disabled}
                  onChange={(e) => setLine(i, { unitPrice: Number(e.target.value) || 0 })}
                />
              </Field>
            </div>
          </div>
        ))}

        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() =>
            onChange({
              ...order,
              lines: [
                ...order.lines,
                { productId: 0, sku: "", label: "", quantity: 0, unitPrice: 0 },
              ],
            })
          }
        >
          <Plus className="h-3.5 w-3.5" />
          Add another product
        </Button>
      </div>

      {/* ---------------------------------------------------------- where */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Area" htmlFor="v-area" required>
          <SearchableSelect
            id="v-area"
            value={order.areaId != null ? String(order.areaId) : ""}
            options={areaOptions}
            includeAll={false}
            allLabel="Pick an area"
            disabled={disabled}
            onChange={(v) => {
              const areaId = Number.parseInt(v, 10);
              const area = options.areas.find((a) => a.id === areaId);
              // The shop goes with the area. Keeping a shop from the old area
              // would save an order against a shop that is not in the area it
              // claims to be in.
              const keep = order.shopId != null
                && [...options.shops, ...added].some((s) => s.id === order.shopId && s.areaId === areaId);
              onChange({
                ...order,
                areaId,
                areaName: area?.name ?? null,
                shopId: keep ? order.shopId : null,
                shopName: keep ? order.shopName : null,
              });
            }}
          />
        </Field>

        <Field label="Shop" htmlFor="v-shop" hint="Optional - leave blank for a direct sale">
          <SearchableSelect
            id="v-shop"
            value={order.shopId != null ? String(order.shopId) : "all"}
            options={shopOptions}
            allLabel="No shop"
            disabled={disabled || order.areaId == null}
            onChange={(v) => {
              const shop = [...options.shops, ...added].find((s) => String(s.id) === v);
              onChange({
                ...order,
                shopId: shop?.id ?? null,
                shopName: shop?.name ?? null,
                // Picking a shop settles the area too.
                ...(shop
                  ? {
                      areaId: shop.areaId,
                      areaName: options.areas.find((a) => a.id === shop.areaId)?.name ?? null,
                    }
                  : {}),
              });
            }}
          />
        </Field>

        <NewShopField
          areaId={order.areaId}
          areaName={order.areaName}
          disabled={disabled}
          onCreated={(shop) => {
            setAdded((list) => [...list, { ...shop, areaId: order.areaId! }]);
            onChange({ ...order, shopId: shop.id, shopName: shop.name });
          }}
        />

        <Field label="Date" htmlFor="v-date" required>
          <Input
            id="v-date"
            type="date"
            value={order.date}
            disabled={disabled}
            onChange={(e) => onChange({ ...order, date: e.target.value })}
          />
        </Field>

        <Field label="Booker" htmlFor="v-booker" hint="Optional">
          <SearchableSelect
            id="v-booker"
            value={order.bookerId != null ? String(order.bookerId) : "all"}
            options={bookerOptions}
            allLabel="No booker"
            disabled={disabled}
            onChange={(v) => {
              const booker = options.bookers.find((b) => String(b.id) === v);
              onChange({ ...order, bookerId: booker?.id ?? null, bookerName: booker?.name ?? null });
            }}
          />
        </Field>

        <Field label="Customer phone" htmlFor="v-phone" hint="Optional">
          <Input
            id="v-phone"
            inputMode="tel"
            value={order.customerPhone ?? ""}
            placeholder="03xx-xxxxxxx"
            disabled={disabled}
            onChange={(e) => onChange({ ...order, customerPhone: e.target.value.trim() || null })}
          />
        </Field>
      </div>
    </div>
  );
}

/**
 * Adding a shop that is not in the list yet, without leaving the order.
 *
 * The booker is standing in the shop. Before this, a shop the catalogue had
 * never heard of meant cancelling the order, going to Areas, adding the shop,
 * and saying the whole thing again - and what came back the second time was
 * usually mangled in a different place.
 *
 * Three things it deliberately does NOT do.
 *
 * The name is TYPED, never pre-filled with what was heard. Whisper gets names
 * wrong constantly - that is the entire reason voice:learn exists - and people
 * accept text that is already in the box. A shop record outlives every order
 * against it, so it is worth the typing.
 *
 * The area is chosen from the list, never created here. A duplicate shop
 * splits one shopkeeper's history; a duplicate AREA splits a whole route, and
 * the dashboard's figures with it. There is a deliberate "naya area add karo"
 * command for when one is really new.
 *
 * And it goes through the same createShop as the Areas page, so the near-match
 * guard applies: a name that folds onto an existing shop reuses it, and one
 * that merely looks like an existing shop comes back asking.
 */
function NewShopField({
  areaId,
  areaName,
  disabled,
  onCreated,
}: {
  areaId: number | null;
  areaName: string | null;
  disabled?: boolean;
  onCreated: (shop: { id: number; name: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);

  const add = async (confirmSimilar: boolean) => {
    if (areaId == null || !name.trim()) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await createShop({ areaId, name: name.trim(), confirmSimilar });
      if (result.ok) {
        onCreated({ id: result.shopId, name: result.name });
        setOpen(false);
        setName("");
        setNeedsConfirm(false);
        return;
      }
      setProblem(result.message);
      setNeedsConfirm((result.similar ?? []).length > 0);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="sm:col-span-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || areaId == null}
          onClick={() => setOpen(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          Shop not in the list?
        </Button>
        {areaId == null ? (
          <p className="mt-1 text-xs text-muted-foreground">Pick the area first.</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border bg-card p-2.5 sm:col-span-2">
      <Field
        label={`New shop in ${areaName ?? "this area"}`}
        htmlFor="v-newshop"
        hint="Type the name as it should be saved - it will be on every invoice for this shop."
      >
        <Input
          id="v-newshop"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNeedsConfirm(false);
            setProblem(null);
          }}
          placeholder="Shop name"
          disabled={disabled || busy}
          autoFocus
        />
      </Field>

      {problem ? <p className="text-xs font-medium text-destructive">{problem}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={disabled || busy || !name.trim()}
          onClick={() => void add(false)}
        >
          {busy ? "Adding..." : "Add shop"}
        </Button>
        {needsConfirm ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || busy}
            onClick={() => void add(true)}
          >
            Add it anyway
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setProblem(null);
            setNeedsConfirm(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
