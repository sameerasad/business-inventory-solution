/**
 * Placeholder for a filter bar while its client component streams in.
 *
 * The filter components read useSearchParams(), so Next needs a Suspense
 * boundary around them - without one it de-opts the whole route out of
 * prerendering. Matching the real bar's height keeps the page from jumping.
 */
export function FilterBarSkeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={className ?? "mb-5 h-[76px] animate-pulse rounded-lg border bg-card"}
    />
  );
}
