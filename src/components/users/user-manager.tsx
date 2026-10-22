"use client";

import { useActionState, useEffect, useState } from "react";
import { KeyRound, Plus, X } from "lucide-react";

import { createUserAction, resetPasswordAction, updateUserAction } from "@/actions/users";
import { emptyActionState, type ActionState } from "@/lib/validations";
import { cn } from "@/lib/utils";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/forms/form-bits";

export type BookerChoice = { id: number; name: string };

export type UserAdmin = {
  id: number;
  username: string;
  name: string;
  role: "admin" | "booker";
  bookerId: number | null;
  bookerName: string | null;
  isActive: boolean;
};

/**
 * Accounts: who can sign in, as what, and whose orders they record.
 *
 * Deliberately separate from the Bookers page. A booker is a person the
 * business attributes orders to, and several of them will never have a login
 * at all; an account is a way into the app. Keeping them as one thing would
 * mean either an account nobody uses for every booker, or no way to record an
 * order for somebody who does not carry a phone.
 */
export function UserManager({
  users,
  bookers,
  selfId,
}: {
  users: UserAdmin[];
  bookers: BookerChoice[];
  /** The signed-in admin, so the page can say "this is you". */
  selfId: number;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-5">
          {adding ? (
            <NewUserForm bookers={bookers} onDone={() => setAdding(false)} />
          ) : (
            <Button type="button" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" />
              Add account
            </Button>
          )}
        </CardContent>
      </Card>

      {users.length === 0 ? (
        <Alert tone="info">
          No accounts yet. Until one exists, the only way in is the emergency password from the
          environment - which is fine for one person and records every action as the owner.
        </Alert>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {users.map((u) => (
            <UserCard key={u.id} user={u} bookers={bookers} isSelf={u.id === selfId} />
          ))}
        </div>
      )}
    </div>
  );
}

function NewUserForm({ bookers, onDone }: { bookers: BookerChoice[]; onDone: () => void }) {
  const [state, formAction, isPending] = useActionState(createUserAction, emptyActionState);
  const [role, setRole] = useState("booker");

  useEffect(() => {
    if (state.ok) onDone();
  }, [state, onDone]);

  return (
    <form action={formAction} className="space-y-4">
      {state.message ? (
        <Alert tone={state.ok ? "success" : "error"}>{state.message}</Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="new-name" required error={state.fieldErrors.name}>
          <Input id="new-name" name="name" disabled={isPending} autoFocus />
        </Field>

        <Field
          label="Username"
          htmlFor="new-username"
          required
          error={state.fieldErrors.username}
          hint="What they type to sign in. Lower case, no spaces."
        >
          <Input
            id="new-username"
            name="username"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={isPending}
          />
        </Field>

        <Field
          label="Password"
          htmlFor="new-password"
          required
          error={state.fieldErrors.password}
          hint="At least 8 characters. You will need to tell them what it is."
        >
          <Input id="new-password" name="password" type="text" disabled={isPending} />
        </Field>

        <Field label="Role" htmlFor="new-role" required error={state.fieldErrors.role}>
          <NativeSelect
            id="new-role"
            name="role"
            value={role}
            onChange={setRole}
            disabled={isPending}
            options={[
              { value: "booker", label: "Booker - their own orders only" },
              { value: "admin", label: "Admin - the whole business" },
            ]}
          />
        </Field>

        <Field
          label="Records orders as"
          htmlFor="new-booker"
          error={state.fieldErrors.bookerId}
          className="sm:col-span-2"
          hint={
            role === "admin"
              ? "Optional for an admin. Set it to also get your own target page."
              : "Required for a booker - this is whose orders they take and whose target they work to."
          }
        >
          <NativeSelect
            id="new-booker"
            name="bookerId"
            defaultValue="none"
            disabled={isPending}
            options={[
              { value: "none", label: "Not a booker" },
              ...bookers.map((b) => ({ value: String(b.id), label: b.name })),
            ]}
          />
        </Field>
      </div>

      <div className="flex items-center gap-2">
        <SubmitButton pending={isPending} pendingLabel="Creating...">
          Create account
        </SubmitButton>
        <Button type="button" variant="ghost" onClick={onDone} disabled={isPending}>
          <X className="h-4 w-4" />
          Cancel
        </Button>
      </div>
    </form>
  );
}

function UserCard({
  user,
  bookers,
  isSelf,
}: {
  user: UserAdmin;
  bookers: BookerChoice[];
  isSelf: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [resetting, setResetting] = useState(false);

  return (
    <Card className={user.isActive ? undefined : "opacity-70"}>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium">
              {user.name}
              {isSelf ? <span className="ml-2 text-xs text-muted-foreground">(you)</span> : null}
            </p>
            <p className="truncate font-mono text-xs text-muted-foreground">{user.username}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant={user.role === "admin" ? "default" : "outline"}>
              {user.role === "admin" ? "Admin" : "Booker"}
            </Badge>
            {user.isActive ? null : <Badge variant="destructive">Disabled</Badge>}
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          {user.bookerName
            ? `Records orders as ${user.bookerName}.`
            : "Not linked to a booker, so it has no orders of its own."}
        </p>

        {editing ? (
          <EditUserForm
            user={user}
            bookers={bookers}
            isSelf={isSelf}
            onDone={() => setEditing(false)}
          />
        ) : resetting ? (
          <ResetPasswordForm user={user} onDone={() => setResetting(false)} />
        ) : (
          <div className="flex items-center gap-1.5">
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setResetting(true)}>
              <KeyRound className="h-4 w-4" />
              Set password
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EditUserForm({
  user,
  bookers,
  isSelf,
  onDone,
}: {
  user: UserAdmin;
  bookers: BookerChoice[];
  isSelf: boolean;
  onDone: () => void;
}) {
  const [state, formAction, isPending] = useActionState(updateUserAction, emptyActionState);

  useEffect(() => {
    if (state.ok) onDone();
  }, [state, onDone]);

  return (
    <form action={formAction} className="space-y-3 border-t pt-3">
      <input type="hidden" name="id" value={user.id} />

      {state.message && !state.ok ? <Alert tone="error">{state.message}</Alert> : null}

      <Field label="Name" htmlFor={`name-${user.id}`} required error={state.fieldErrors.name}>
        <Input id={`name-${user.id}`} name="name" defaultValue={user.name} disabled={isPending} />
      </Field>

      <Field label="Role" htmlFor={`role-${user.id}`} required error={state.fieldErrors.role}>
        <NativeSelect
          id={`role-${user.id}`}
          name="role"
          defaultValue={user.role}
          disabled={isPending}
          options={[
            { value: "booker", label: "Booker" },
            { value: "admin", label: "Admin" },
          ]}
        />
      </Field>

      <Field
        label="Records orders as"
        htmlFor={`booker-${user.id}`}
        error={state.fieldErrors.bookerId}
      >
        <NativeSelect
          id={`booker-${user.id}`}
          name="bookerId"
          defaultValue={user.bookerId == null ? "none" : String(user.bookerId)}
          disabled={isPending}
          options={[
            { value: "none", label: "Not a booker" },
            ...bookers.map((b) => ({ value: String(b.id), label: b.name })),
          ]}
        />
      </Field>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="isActive"
          value="true"
          defaultChecked={user.isActive}
          disabled={isPending}
          className="h-4 w-4 rounded border-input"
        />
        <span>
          Can sign in
          {isSelf ? (
            <span className="ml-1 text-xs text-muted-foreground">
              - turning this off locks you out
            </span>
          ) : null}
        </span>
      </label>

      <div className="flex items-center gap-2">
        <SubmitButton pending={isPending} pendingLabel="Saving..." size="sm">
          Save
        </SubmitButton>
        <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={isPending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Set a password for somebody else.
 *
 * Shown as plain text, not a password field. The admin typing it has to read
 * it back to the person it belongs to, and a row of dots they cannot check is
 * how a booker ends up locked out on their first morning.
 */
function ResetPasswordForm({ user, onDone }: { user: UserAdmin; onDone: () => void }) {
  const [state, formAction, isPending] = useActionState(resetPasswordAction, emptyActionState);

  return (
    <form action={formAction} className="space-y-3 border-t pt-3">
      <input type="hidden" name="id" value={user.id} />

      {state.message ? (
        <Alert tone={state.ok ? "success" : "error"}>{state.message}</Alert>
      ) : null}

      <Field
        label="New password"
        htmlFor={`pw-${user.id}`}
        required
        error={state.fieldErrors.password}
        hint="At least 8 characters. Shown as you type so you can read it out."
      >
        <Input id={`pw-${user.id}`} name="password" type="text" disabled={isPending} autoFocus />
      </Field>

      <div className="flex items-center gap-2">
        <SubmitButton pending={isPending} pendingLabel="Setting..." size="sm">
          Set password
        </SubmitButton>
        <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={isPending}>
          Done
        </Button>
      </div>
    </form>
  );
}

/**
 * A plain <select>.
 *
 * The app's Radix select is controlled and posts nothing on its own, which
 * suits the filter bars it was built for. These forms are posted, read on a
 * phone, and have a handful of options each, so the browser's own control is
 * both simpler and better behaved.
 */
export function NativeSelect({
  id,
  name,
  options,
  value,
  defaultValue,
  onChange,
  disabled,
  className,
}: {
  id?: string;
  name: string;
  options: { value: string; label: string }[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <select
      id={id}
      name={name}
      value={value}
      defaultValue={defaultValue}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      disabled={disabled}
      className={cn(
        "flex h-10 w-full items-center rounded-md border border-input bg-card px-3 py-2 text-sm",
        "ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
        "disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground",
        className,
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
