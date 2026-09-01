"use client";

import { useActionState, useEffect, useState } from "react";
import { Check, Pencil, Plus, Store, Trash2, X } from "lucide-react";

import {
  createAreaAction,
  createShopAction,
  deleteAreaAction,
  deleteShopAction,
  renameAreaAction,
  renameShopAction,
} from "@/actions/areas";
import { emptyActionState, type ActionState } from "@/lib/validations";
import type { AreaWithShops } from "@/lib/queries";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/forms/form-bits";

/**
 * Areas and their shops. Sales are grouped by area on the dashboard, and a shop
 * is optional on a sale, so an area can exist with no shops (that is what
 * "Online" is for).
 *
 * Both are soft-deleted and both refuse to disappear while sales point at them -
 * removing one would leave those sales without the label the dashboard groups by.
 */
export function AreaManager({ areas }: { areas: AreaWithShops[] }) {
  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="p-5">
          <NameForm
            action={createAreaAction}
            label="New area"
            placeholder="e.g. West Zone"
            submitLabel="Add area"
          />
        </CardContent>
      </Card>

      {areas.length === 0 ? (
        <Alert tone="info">
          No areas yet. Add your first one above - every sale has to be attributed to an area.
        </Alert>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {areas.map((area) => (
            <AreaCard key={area.id} area={area} />
          ))}
        </div>
      )}
    </div>
  );
}

function AreaCard({ area }: { area: AreaWithShops }) {
  const [renaming, setRenaming] = useState(false);

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          {renaming ? (
            <div className="flex-1">
              <NameForm
                action={renameAreaAction}
                hiddenId={area.id}
                label="Rename area"
                defaultValue={area.name}
                submitLabel="Save"
                compact
                onSuccess={() => setRenaming(false)}
                onCancel={() => setRenaming(false)}
              />
            </div>
          ) : (
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold">{area.name}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {area.shops.length} shop{area.shops.length === 1 ? "" : "s"} ·{" "}
                {area.salesCount} sale{area.salesCount === 1 ? "" : "s"}
              </p>
            </div>
          )}

          {!renaming ? (
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => setRenaming(true)}>
                <Pencil className="h-3.5 w-3.5" />
                Rename
              </Button>
              <DeleteButton
                action={deleteAreaAction}
                id={area.id}
                label={`Delete area ${area.name}`}
                disabled={area.salesCount > 0}
                disabledReason={`${area.salesCount} sale(s) recorded here`}
              />
            </div>
          ) : null}
        </div>

        <div className="space-y-2 border-t pt-4">
          {area.shops.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No shops. Sales in this area will be recorded as direct sales.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {area.shops.map((shop) => (
                <ShopRow key={shop.id} shop={shop} />
              ))}
            </ul>
          )}

          <NameForm
            action={createShopAction}
            hiddenAreaId={area.id}
            label="Add shop"
            placeholder="Shop name"
            withAddress
            submitLabel="Add"
            compact
            icon={<Plus className="h-4 w-4" />}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function ShopRow({
  shop,
}: {
  shop: { id: number; name: string; address: string | null; salesCount: number };
}) {
  const [renaming, setRenaming] = useState(false);

  if (renaming) {
    return (
      <li>
        <NameForm
          action={renameShopAction}
          hiddenId={shop.id}
          label="Edit shop"
          defaultValue={shop.name}
          withAddress
          defaultAddress={shop.address ?? ""}
          submitLabel="Save"
          compact
          onSuccess={() => setRenaming(false)}
          onCancel={() => setRenaming(false)}
        />
      </li>
    );
  }

  return (
    <li className="flex items-start justify-between gap-2 rounded-md border px-2.5 py-1.5">
      <span className="flex min-w-0 flex-col gap-0.5 text-sm">
        <span className="flex min-w-0 items-center gap-2">
          <Store className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{shop.name}</span>
          {shop.salesCount > 0 ? (
            <Badge variant="outline">{shop.salesCount} sales</Badge>
          ) : null}
        </span>
        {shop.address ? (
          <span className="pl-5 text-xs text-muted-foreground">{shop.address}</span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setRenaming(true)}
          aria-label={`Rename ${shop.name}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <DeleteButton
          action={deleteShopAction}
          id={shop.id}
          label={`Delete shop ${shop.name}`}
          disabled={shop.salesCount > 0}
          disabledReason={`${shop.salesCount} sale(s) recorded here`}
          iconOnly
        />
      </span>
    </li>
  );
}

/** One text input plus a submit, reused for create-area, rename-area, create-shop, rename-shop. */
function NameForm({
  action,
  label,
  placeholder,
  submitLabel,
  defaultValue = "",
  hiddenId,
  hiddenAreaId,
  compact,
  icon,
  withAddress,
  defaultAddress = "",
  onSuccess,
  onCancel,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  label: string;
  placeholder?: string;
  submitLabel: string;
  defaultValue?: string;
  hiddenId?: number;
  hiddenAreaId?: number;
  compact?: boolean;
  icon?: React.ReactNode;
  /** Shops carry an optional delivery address; areas do not. */
  withAddress?: boolean;
  defaultAddress?: string;
  onSuccess?: () => void;
  onCancel?: () => void;
}) {
  const [state, formAction, isPending] = useActionState(action, emptyActionState);
  const [value, setValue] = useState(defaultValue);
  const [address, setAddress] = useState(defaultAddress);

  useEffect(() => {
    if (state.ok) {
      // A create form empties itself; a rename form closes.
      if (onSuccess) onSuccess();
      else {
        setValue("");
        setAddress("");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const inputId = `name-${label.replace(/\s+/g, "-").toLowerCase()}-${hiddenId ?? hiddenAreaId ?? "new"}`;

  return (
    <form action={formAction} className="space-y-1.5">
      {hiddenId != null ? <input type="hidden" name="id" value={hiddenId} /> : null}
      {hiddenAreaId != null ? <input type="hidden" name="areaId" value={hiddenAreaId} /> : null}

      {!compact ? <Label htmlFor={inputId}>{label}</Label> : null}

      <div className="flex items-start gap-2">
        <div className="flex-1">
          <Input
            id={inputId}
            name="name"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            aria-label={compact ? label : undefined}
            aria-invalid={state.fieldErrors.name ? true : undefined}
            disabled={isPending}
            required
          />
        </div>
        <SubmitButton
          pending={isPending}
          variant={compact ? "outline" : "default"}
          size={compact ? "default" : "default"}
          pendingLabel="..."
          disabled={!value.trim()}
        >
          {icon ?? (onSuccess ? <Check className="h-4 w-4" /> : null)}
          {submitLabel}
        </SubmitButton>
        {onCancel ? (
          <Button type="button" variant="ghost" size="icon" onClick={onCancel} aria-label="Cancel">
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      {withAddress ? (
        <Input
          name="address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Delivery address (optional) - prints on invoices"
          aria-label="Shop address"
          disabled={isPending}
        />
      ) : null}

      {state.message && !state.ok ? (
        <p className="text-xs font-medium text-destructive">{state.message}</p>
      ) : null}
    </form>
  );
}

function DeleteButton({
  action,
  id,
  label,
  disabled,
  disabledReason,
  iconOnly,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  id: number;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
  iconOnly?: boolean;
}) {
  const [state, formAction, isPending] = useActionState(action, emptyActionState);

  return (
    <form action={formAction} className="inline-flex flex-col items-end">
      <input type="hidden" name="id" value={id} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        disabled={disabled || isPending}
        aria-label={label}
        title={disabled ? disabledReason : label}
      >
        <Trash2 className="h-3.5 w-3.5" />
        {iconOnly ? null : "Delete"}
      </Button>
      {state.message && !state.ok ? (
        <span className="max-w-[220px] text-right text-xs text-destructive">{state.message}</span>
      ) : null}
    </form>
  );
}
