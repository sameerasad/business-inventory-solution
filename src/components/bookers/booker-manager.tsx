"use client";

import { useActionState, useEffect, useState } from "react";
import { Pencil, Plus, Trash2, X } from "lucide-react";

import {
  createBookerAction,
  deleteBookerAction,
  toggleBookerActiveAction,
  updateBookerAction,
} from "@/actions/bookers";
import { emptyActionState, type ActionState } from "@/lib/validations";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/forms/form-bits";

export type BookerAdmin = {
  id: number;
  name: string;
  code: string | null;
  phone: string | null;
  notes: string | null;
  isActive: boolean;
  bookings: number;
};

/**
 * Add, edit, retire and remove bookers.
 *
 * Retire and remove are different on purpose. Someone who has left is RETIRED:
 * their bookings and every figure built on them stay exactly as they were, they
 * just stop appearing in the booking form. Remove is only for a booker added by
 * mistake, and is refused the moment they have a booking - otherwise the
 * performance history would lose the attribution it is made of.
 */
export function BookerManager({ bookers }: { bookers: BookerAdmin[] }) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-5">
          {adding ? (
            <BookerForm
              action={createBookerAction}
              submitLabel="Add booker"
              onDone={() => setAdding(false)}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <Button type="button" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" />
              Add booker
            </Button>
          )}
        </CardContent>
      </Card>

      {bookers.length === 0 ? (
        <Alert tone="info">
          No bookers yet. Add the people who take orders, then pick one on every new booking so
          their performance is tracked.
        </Alert>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {bookers.map((b) => (
            <BookerCard key={b.id} booker={b} />
          ))}
        </div>
      )}
    </div>
  );
}

function BookerCard({ booker }: { booker: BookerAdmin }) {
  const [editing, setEditing] = useState(false);

  return (
    <Card className={booker.isActive ? undefined : "opacity-70"}>
      <CardContent className="p-4">
        {editing ? (
          <BookerForm
            action={updateBookerAction}
            hiddenId={booker.id}
            submitLabel="Save"
            defaults={booker}
            onDone={() => setEditing(false)}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <span className="truncate">{booker.name}</span>
                {booker.code ? (
                  <span className="font-mono text-xs text-muted-foreground">{booker.code}</span>
                ) : null}
                {!booker.isActive ? <Badge variant="outline">Retired</Badge> : null}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {[booker.phone, `${booker.bookings} booking${booker.bookings === 1 ? "" : "s"}`]
                  .filter(Boolean)
                  .join("  ·  ")}
              </p>
              {booker.notes ? (
                <p className="mt-1 text-xs text-muted-foreground">{booker.notes}</p>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </Button>
              <ToggleActive booker={booker} />
              <DeleteBooker booker={booker} />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BookerForm({
  action,
  submitLabel,
  hiddenId,
  defaults,
  onDone,
  onCancel,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  submitLabel: string;
  hiddenId?: number;
  defaults?: Partial<BookerAdmin>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [state, formAction, isPending] = useActionState(action, emptyActionState);
  const [name, setName] = useState(defaults?.name ?? "");
  const [code, setCode] = useState(defaults?.code ?? "");
  const [phone, setPhone] = useState(defaults?.phone ?? "");
  const [notes, setNotes] = useState(defaults?.notes ?? "");

  useEffect(() => {
    if (state.ok) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const id = hiddenId ?? "new";

  return (
    <form action={formAction} className="space-y-3">
      {hiddenId != null ? <input type="hidden" name="id" value={hiddenId} /> : null}

      {state.message && !state.ok ? <Alert tone="error">{state.message}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name" htmlFor={`bk-name-${id}`} required error={state.fieldErrors.name}>
          <Input
            id={`bk-name-${id}`}
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Imran Ali"
            disabled={isPending}
            required
            autoFocus
          />
        </Field>
        <Field label="Code" htmlFor={`bk-code-${id}`} error={state.fieldErrors.code} hint="Optional">
          <Input
            id={`bk-code-${id}`}
            name="code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. B-04"
            disabled={isPending}
          />
        </Field>
        <Field label="Phone" htmlFor={`bk-phone-${id}`} error={state.fieldErrors.phone} hint="Optional">
          <Input
            id={`bk-phone-${id}`}
            name="phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="e.g. 0300-1234567"
            disabled={isPending}
          />
        </Field>
      </div>

      <Field label="Notes" htmlFor={`bk-notes-${id}`} error={state.fieldErrors.notes}>
        <Input
          id={`bk-notes-${id}`}
          name="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional. Route, vehicle, anything worth remembering."
          disabled={isPending}
        />
      </Field>

      <div className="flex items-center gap-2">
        <SubmitButton pending={isPending} disabled={!name.trim()}>
          {submitLabel}
        </SubmitButton>
        <Button type="button" variant="ghost" size="icon" onClick={onCancel} aria-label="Cancel">
          <X className="h-4 w-4" />
        </Button>
      </div>
    </form>
  );
}

function ToggleActive({ booker }: { booker: BookerAdmin }) {
  const [state, formAction, isPending] = useActionState(
    toggleBookerActiveAction,
    emptyActionState,
  );
  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={booker.id} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        disabled={isPending}
        title={
          booker.isActive
            ? "Retire: hides them from the booking form, keeps all their history"
            : "Make them selectable again"
        }
      >
        {booker.isActive ? "Retire" : "Restore"}
      </Button>
      {state.message && !state.ok ? (
        <span className="text-xs text-destructive">{state.message}</span>
      ) : null}
    </form>
  );
}

function DeleteBooker({ booker }: { booker: BookerAdmin }) {
  const [state, formAction, isPending] = useActionState(deleteBookerAction, emptyActionState);
  const blocked = booker.bookings > 0;
  return (
    <form action={formAction} className="flex flex-col items-end">
      <input type="hidden" name="id" value={booker.id} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        disabled={isPending || blocked}
        aria-label={`Remove ${booker.name}`}
        title={
          blocked
            ? `${booker.bookings} booking(s) recorded - retire them instead`
            : `Remove ${booker.name}`
        }
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
      {state.message && !state.ok ? (
        <span className="max-w-[220px] text-right text-xs text-destructive">{state.message}</span>
      ) : null}
    </form>
  );
}
