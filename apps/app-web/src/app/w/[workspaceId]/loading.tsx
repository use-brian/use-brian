/**
 * Route-level fallback for everything under `/w/[workspaceId]/`. The
 * doc surface owns the full viewport, so the fallback is a single
 * thin placeholder bar — it disappears on the same render the
 * DocShell mounts.
 */
export default function WorkspaceRouteLoading() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <span className="sr-only">Loading…</span>
    </div>
  );
}
