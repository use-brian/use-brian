import { cn } from "@/lib/utils";

/**
 * Shimmering placeholder block. Pair with explicit sizing classes
 * (e.g. `h-3 w-32`) to match the eventual content shape — that's what
 * makes the swap-in feel quiet instead of janky.
 */
export function Skeleton({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn("skeleton", className)} {...rest} />;
}

/**
 * Card-shaped skeleton row used by list pages (drafts, inbox, posted,
 * voice, etc). Mirrors the real card geometry so the page doesn't
 * shift on first paint.
 */
function CardSkeleton({
  lines = 2,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card p-4 space-y-3",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-3 w-14" />
      </div>
      <div className="space-y-1.5">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton
            key={i}
            className={cn("h-3", i === lines - 1 ? "w-3/5" : "w-full")}
          />
        ))}
      </div>
    </div>
  );
}

export function CardSkeletonList({
  count = 4,
  lines = 2,
}: {
  count?: number;
  lines?: number;
}) {
  return (
    <ul className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <li key={i}>
          <CardSkeleton lines={lines} />
        </li>
      ))}
    </ul>
  );
}
