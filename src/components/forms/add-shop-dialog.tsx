"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";

import { createShop } from "@/actions/areas";
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

/**
 * "The shop is not in the list" escape hatch on the New Sale form.
 * Creates the shop against the already-selected area and hands the new id back
 * so the caller can select it immediately, without losing the rest of the form.
 */
export function AddShopDialog({
  areaId,
  areaName,
  onCreated,
}: {
  areaId: number | null;
  areaName: string | null;
  onCreated: (shop: {
    id: number;
    name: string;
    address: string | null;
    phone: string | null;
    areaId: number;
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    if (areaId == null) {
      setError("Pick an area first.");
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Shop name is required.");
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await createShop({
        areaId,
        name: trimmed,
        address: address.trim(),
        phone: phone.trim(),
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onCreated({
        id: result.shopId,
        name: result.name,
        address: result.address,
        phone: result.phone,
        areaId,
      });
      setName("");
      setAddress("");
      setPhone("");
      setOpen(false);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={areaId == null}
        onClick={() => setOpen(true)}
      >
        <Plus className="h-4 w-4" />
        New shop
      </Button>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a shop</DialogTitle>
          <DialogDescription>
            {areaName ? `The shop will be added to ${areaName}.` : "Pick an area first."}
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <Field label="Shop name" htmlFor="new-shop-name" required>
          <Input
            id="new-shop-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Riverside Mini Mart"
            disabled={pending}
            autoFocus
            onKeyDown={(e) => {
              // Enter inside a dialog nested in the sale form must not submit the sale.
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
        </Field>

        <Field label="WhatsApp / phone" htmlFor="new-shop-phone" hint="Optional. Pre-fills the send-on-WhatsApp dialog.">
          <Input
            id="new-shop-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="e.g. 0300-1234567"
            disabled={pending}
          />
        </Field>

        <Field label="Address" htmlFor="new-shop-address" hint="Optional. Prints on invoices for this shop.">
          <Input
            id="new-shop-address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="e.g. Shop 12, Block C, Jinnah Road"
            disabled={pending}
          />
        </Field>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={pending}>
            {pending ? "Adding..." : "Add shop"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
