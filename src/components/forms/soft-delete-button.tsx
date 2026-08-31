"use client";

import { useActionState, useState } from "react";
import { Trash2 } from "lucide-react";

import { emptyActionState, type ActionState } from "@/lib/validations";
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
import { SubmitButton } from "@/components/forms/form-bits";

/**
 * Soft delete behind a confirmation, with an optional reason that lands in the
 * audit log. Nothing here removes a row - it flips is_deleted, so the record stays
 * available for reconciliation.
 */
export function SoftDeleteButton({
  action,
  id,
  title,
  description,
  confirmLabel = "Remove",
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  id: number;
  title: string;
  description: string;
  confirmLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(action, emptyActionState);

  // Kept open on success so the outcome is visible; the row disappears on
  // revalidation either way.
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={title}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>

      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {state.message ? (
          <Alert tone={state.ok ? "success" : "error"}>{state.message}</Alert>
        ) : null}

        {!state.ok ? (
          <form action={formAction} className="space-y-4">
            <input type="hidden" name="id" value={id} />
            <Field label="Reason" htmlFor={`reason-${id}`} hint="Optional. Recorded in the audit log.">
              <Input
                id={`reason-${id}`}
                name="reason"
                placeholder="e.g. entered twice by mistake"
                disabled={isPending}
              />
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={isPending}
              >
                Cancel
              </Button>
              <SubmitButton pending={isPending} variant="destructive" pendingLabel="Removing...">
                {confirmLabel}
              </SubmitButton>
            </DialogFooter>
          </form>
        ) : (
          <DialogFooter>
            <Button type="button" onClick={() => setOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
