"use client";

import { useActionState } from "react";

import { signInAction } from "@/actions/auth";
import { emptyActionState } from "@/lib/validations";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/forms/form-bits";

export function LoginForm({ next }: { next: string }) {
  const [state, formAction, isPending] = useActionState(signInAction, emptyActionState);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="next" value={next} />

      {state.message && !state.ok ? <Alert tone="error">{state.message}</Alert> : null}

      <Field label="Password" htmlFor="password" required error={state.fieldErrors.password}>
        <Input
          id="password"
          name="password"
          type="password"
          // The phone keyboard should not autocapitalise or autocorrect a
          // password, and a browser remembering it is the point.
          autoComplete="current-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={isPending}
          required
          autoFocus
        />
      </Field>

      <SubmitButton pending={isPending} pendingLabel="Signing in..." className="w-full">
        Sign in
      </SubmitButton>
    </form>
  );
}
