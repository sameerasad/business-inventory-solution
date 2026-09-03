"use client";

import { useActionState, useEffect, useState } from "react";
import { Check, Plus, X } from "lucide-react";

import {
  createCategoryAction,
  deleteCategoryAction,
  renameCategoryAction,
} from "@/actions/categories";
import { emptyActionState, type ActionState } from "@/lib/validations";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/forms/form-bits";
import { HardDeleteButton } from "@/components/forms/edit-dialog";

export type CategoryAdmin = { id: number; name: string; products: number };

/**
 * Categories: add, rename, delete.
 *
 * Deleting is refused while any product still belongs to the category, which is
 * why the count sits next to the name - it is the reason the button is disabled.
 */
export function CategoryManager({ categories }: { categories: CategoryAdmin[] }) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {categories.map((c) => (
          <CategoryChip key={c.id} category={c} />
        ))}

        {adding ? null : (
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" />
            New category
          </Button>
        )}
      </div>

      {adding ? (
        <Card>
          <CardContent className="p-4">
            <NameForm
              action={createCategoryAction}
              label="New category"
              placeholder="e.g. Snacks"
              submitLabel="Add category"
              onDone={() => setAdding(false)}
              onCancel={() => setAdding(false)}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function CategoryChip({ category }: { category: CategoryAdmin }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <Card className="w-full">
        <CardContent className="p-4">
          <NameForm
            action={renameCategoryAction}
            hiddenId={category.id}
            label={`Rename "${category.name}"`}
            defaultValue={category.name}
            submitLabel="Save"
            onDone={() => setEditing(false)}
            onCancel={() => setEditing(false)}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <span className="flex items-center gap-1 rounded-full border bg-card py-0.5 pl-3 pr-1 text-sm">
      <span className="font-medium">{category.name}</span>
      <Badge variant="secondary" className="font-normal">
        {category.products}
      </Badge>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7"
        onClick={() => setEditing(true)}
      >
        Rename
      </Button>
      <HardDeleteButton
        action={deleteCategoryAction}
        id={category.id}
        title={`Delete "${category.name}"?`}
        description="The category is removed for good. Nothing else changes - no product belongs to it."
        disabled={category.products > 0}
        disabledReason={`${category.products} product(s) are in this category. Move them first.`}
      />
    </span>
  );
}

function NameForm({
  action,
  label,
  hiddenId,
  defaultValue,
  placeholder,
  submitLabel,
  onDone,
  onCancel,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  label: string;
  hiddenId?: number;
  defaultValue?: string;
  placeholder?: string;
  submitLabel: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [state, formAction, isPending] = useActionState(action, emptyActionState);
  const [name, setName] = useState(defaultValue ?? "");

  useEffect(() => {
    if (state.ok) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={formAction} className="space-y-3">
      {hiddenId != null ? <input type="hidden" name="id" value={hiddenId} /> : null}
      {state.message && !state.ok ? <Alert tone="error">{state.message}</Alert> : null}

      <Field
        label={label}
        htmlFor={`cat-${hiddenId ?? "new"}`}
        required
        error={state.fieldErrors.name}
      >
        <Input
          id={`cat-${hiddenId ?? "new"}`}
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={placeholder}
          disabled={isPending}
          required
          autoFocus
        />
      </Field>

      <div className="flex items-center gap-2">
        <SubmitButton pending={isPending} disabled={!name.trim()}>
          <Check className="h-4 w-4" />
          {submitLabel}
        </SubmitButton>
        <Button type="button" variant="ghost" size="icon" onClick={onCancel} aria-label="Cancel">
          <X className="h-4 w-4" />
        </Button>
      </div>
    </form>
  );
}
