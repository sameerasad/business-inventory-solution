"use client";

import { useState } from "react";

import { updateBookingAction } from "@/actions/bookings";
import { EditDialog } from "@/components/forms/edit-dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AreaOption } from "@/components/forms/sale-form";

const NO_SHOP = "none";
const NO_BOOKER = "none";

export type EditableBooking = {
  id: number;
  invoiceNo: string;
  customerName: string | null;
  customerPhone: string | null;
  areaId: number;
  shopId: number | null;
  bookerId: number | null;
  bookingDate: string;
  notes: string | null;
};

/**
 * Correct an invoice's own details: who it is for, when, where, and who took it.
 *
 * The order lines are not here. A line is a sale row with its own batch and its
 * own stock movement, so it is edited on the Sales page - one rule for
 * inventory, not two.
 *
 * Moving the date moves the delivery dates with it, because a delivery cannot be
 * dated differently from the order. Payments keep their own dates: when the
 * money arrived is a separate fact.
 */
export function EditBookingDialog({
  booking,
  areas,
  bookers,
}: {
  booking: EditableBooking;
  areas: AreaOption[];
  bookers: { id: number; name: string }[];
}) {
  const [areaId, setAreaId] = useState(String(booking.areaId));
  const [shopId, setShopId] = useState(booking.shopId == null ? NO_SHOP : String(booking.shopId));
  const [bookerId, setBookerId] = useState(
    booking.bookerId == null ? NO_BOOKER : String(booking.bookerId),
  );

  const selectedArea = areas.find((a) => String(a.id) === areaId) ?? null;

  return (
    <EditDialog
      action={updateBookingAction}
      title={`Edit ${booking.invoiceNo}`}
      description="The invoice details. Product lines are edited on the Sales page, where the stock they moved lives."
      formKey={`${booking.id}-${booking.bookingDate}-${booking.areaId}-${booking.shopId}-${booking.bookerId}`}
      footerNote="Changing the date moves the delivery dates on this invoice too. Payments keep their own dates."
    >
      {(state, isPending) => (
        <>
          <input type="hidden" name="id" value={booking.id} />
          <input type="hidden" name="areaId" value={areaId} />
          <input type="hidden" name="shopId" value={shopId === NO_SHOP ? "" : shopId} />
          <input type="hidden" name="bookerId" value={bookerId === NO_BOOKER ? "" : bookerId} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Booking date"
              htmlFor={`bk-date-${booking.id}`}
              required
              error={state.fieldErrors.bookingDate}
            >
              <Input
                id={`bk-date-${booking.id}`}
                name="bookingDate"
                type="date"
                defaultValue={booking.bookingDate}
                disabled={isPending}
                required
              />
            </Field>

            <Field label="Booker" error={state.fieldErrors.bookerId}>
              <Select value={bookerId} onValueChange={setBookerId} disabled={isPending}>
                <SelectTrigger>
                  <SelectValue placeholder="No booker" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_BOOKER}>No booker</SelectItem>
                  {bookers.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field
              label="Customer name"
              htmlFor={`bk-cust-${booking.id}`}
              error={state.fieldErrors.customerName}
              hint="Optional. Blank prints as walk-in customer."
            >
              <Input
                id={`bk-cust-${booking.id}`}
                name="customerName"
                defaultValue={booking.customerName ?? ""}
                disabled={isPending}
              />
            </Field>

            <Field
              label="Customer phone"
              htmlFor={`bk-phone-${booking.id}`}
              error={state.fieldErrors.customerPhone}
              hint="Used to pre-fill the WhatsApp share."
            >
              <Input
                id={`bk-phone-${booking.id}`}
                name="customerPhone"
                defaultValue={booking.customerPhone ?? ""}
                disabled={isPending}
              />
            </Field>

            <Field label="Area" required error={state.fieldErrors.areaId}>
              <Select
                value={areaId}
                onValueChange={(v) => {
                  setAreaId(v);
                  setShopId(NO_SHOP);
                }}
                disabled={isPending}
              >
                <SelectTrigger>
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

            <Field label="Shop" error={state.fieldErrors.shopId}>
              <Select value={shopId} onValueChange={setShopId} disabled={isPending}>
                <SelectTrigger>
                  <SelectValue placeholder="No shop" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_SHOP}>No shop</SelectItem>
                  {(selectedArea?.shops ?? []).map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field label="Notes" htmlFor={`bk-notes-${booking.id}`} error={state.fieldErrors.notes}>
            <Textarea
              id={`bk-notes-${booking.id}`}
              name="notes"
              rows={2}
              defaultValue={booking.notes ?? ""}
              disabled={isPending}
            />
          </Field>
        </>
      )}
    </EditDialog>
  );
}
