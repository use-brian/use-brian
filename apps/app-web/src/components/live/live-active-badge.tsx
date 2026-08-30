/**
 * Persistent top-level Live count. It deliberately reuses Inbox's compact
 * corner-badge grammar while carrying a different signal: non-settled work.
 *
 * [COMP:app-web/live-app]
 */

export function LiveActiveBadge({
  count,
  label,
}: {
  count: number;
  label: string;
}) {
  if (count <= 0) return null;
  return (
    <span
      data-live-active-count={count}
      aria-label={label}
      className="absolute -right-0.5 -top-0.5 inline-flex min-w-[15px] items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-[15px] text-primary-foreground ring-2 ring-sidebar motion-safe:animate-pulse motion-reduce:animate-none"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
