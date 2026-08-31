// Test-only stand-in for next/cache so the server actions can run outside a
// Next.js request context. Mapped in via tsconfig.verify.json.
export function revalidatePath(_path: string): void {}
export function revalidateTag(_tag: string): void {}
export function unstable_cache<T>(fn: T): T {
  return fn;
}
