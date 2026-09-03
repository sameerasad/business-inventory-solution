"use client";

import { useActionState, useEffect, useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";

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
import { SubmitButton } from "@/components/forms/form-bits";

/**
 * The shell every edit form in the app shares: a trigger, a dialog, the error
 * banner, and a footer that closes on success.
 *
 * The fields themselves are passed as a render prop rather than described in
 * config, because each entity has its own rules - a batch needs to know how many
 * units are already sold, a sale needs the batches for its own product - and a
 * generic field schema would end up encoding all of that anyway.
 *
 * `formKey` remounts the fields whenever the underlying row changes, so a dialog
 * reopened after a save shows the saved values rather than the ones typed
 * before it.
 */
export function EditDialog({
  action,
  title,
  description,
  triggerLabel = "Edit",
  triggerIcon = true,
  submitLabel = "Save changes",
  width = "max-w-lg",
  formKey,
  children,
  footerNote,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  title: string;
  description?: string;
  triggerLabel?: string;
  triggerIcon?: boolean;
  submitLabel?: string;
  width?: string;
  formKey?: string | number;
  /** Receives the live action state so fields can show their own errors. */
  children: (state: ActionState, isPending: boolean) => ReactNode;
  footerNote?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(action, emptyActionState);

  useEffect(() => {
    if (state.ok) setOpen(false);
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`${triggerLabel}: ${title}`}
      >
        {triggerIcon ? <Pencil className="h-3.5 w-3.5" /> : null}
        {triggerLabel}
      </Button>

      <DialogContent className={width}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        {state.message && !state.ok ? <Alert tone="error">{state.message}</Alert> : null}

        <form action={formAction} className="space-y-4" key={formKey}>
          {children(state, isPending)}

          {footerNote ? <p className="text-xs text-muted-foreground">{footerNote}</p> : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <SubmitButton pending={isPending}>{submitLabel}</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A destructive action behind a confirmation, for rows that are deleted outright
 * rather than soft-deleted (categories and unused products).
 *
 * Separate from SoftDeleteButton on purpose: that one offers a reason field
 * because the record survives to carry it. Here the row is gone, so the only
 * thing worth asking is whether you meant it.
 */
export function HardDeleteButton({
  action,
  id,
  title,
  description,
  disabled,
  disabledReason,
  confirmLabel = "Delete",
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  id: number;
  title: string;
  description: string;
  disabled?: boolean;
  disabledReason?: string;
  confirmLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(action, emptyActionState);

  if (disabled) {
    return (
      <Button variant="ghost" size="sm" disabled title={disabledReason}>
        {confirmLabel}
      </Button>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className="text-destructive hover:text-destructive"
      >
        {confirmLabel}
      </Button>

      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {state.message ? (
          <Alert tone={state.ok ? "success" : "error"}>{state.message}</Alert>
        ) : null}

        <form action={formAction}>
          <input type="hidden" name="id" value={id} />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <SubmitButton pending={isPending} variant="destructive">
              {confirmLabel}
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
