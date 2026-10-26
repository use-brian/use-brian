/**
 * Surface-shaped loading skeletons - the visible half of progressive loading.
 *
 * Every `/w/[workspaceId]/*` surface is a client component that fetches its own
 * data on mount, so entering one used to paint an empty pane (or a bare "...")
 * for a full round trip. These skeletons are what the route-level `loading.tsx`
 * files render instead: the surface's real geometry (chrome row height, rail,
 * column widths, row rhythm) drawn in placeholder blocks, so the frame is on
 * screen in the first frame after a click and the real content swaps into a
 * layout that already matches. That is the whole trick - the wait is the same
 * length, but it stops reading as a stall.
 *
 * Rules these follow:
 *  - **Decorative only.** `aria-hidden`, ZERO user-facing strings. That keeps
 *    them free of `useT()`, which keeps them server-renderable with no client
 *    JS - a `loading.tsx` must not itself wait on a chunk to download.
 *  - **Geometry first.** Each mirrors the real surface's measurements (the
 *    `h-11 border-b` chrome row every surface tops out with, the `w-56`
 *    sidebar, the `sm:grid-cols-2 lg:grid-cols-3` card grid). A skeleton that
 *    does not match its surface produces a layout jump on swap-in, which feels
 *    worse than the blank it replaced.
 *  - **Built on the existing primitive.** `<Skeleton>` / the `.skeleton` class
 *    in `globals.css` (shimmer sweep + reduced-motion fallback), the same one
 *    the Feed surfaces already use. No parallel shimmer system.
 *
 * Spec: docs/architecture/features/perceived-performance.md
 * [COMP:app-web/surface-skeleton]
 */

import { Skeleton } from "@/components/skeleton";
import { BrainGraphLoadingSkeleton } from "@/components/brain/graph-loading";
import type { WorkspaceSurface } from "@/lib/doc-page-url";
import { cn } from "@/lib/utils";

/** The distinct skeleton shapes a workspace surface can wear. */
export type SurfaceSkeletonKind = "page" | "list" | "grid" | "rail" | "brain" | "none";

/**
 * Which skeleton shape a surface loads behind. Pure so a test can pin that
 * every `WorkspaceSurface` is classified - an unmapped surface would silently
 * fall back to the page shape and paint the wrong frame.
 *
 * Home and Chat have no content-shaped loading frame: a fresh conversation
 * needs only its welcome and composer, not placeholder rows.
 */
export function surfaceSkeletonKind(
  surface: WorkspaceSurface | null,
): SurfaceSkeletonKind {
  switch (surface) {
    case "chat":
    case null:
    case undefined:
      return "none";
    case "brain":
      return "brain";
    // Studio opens as "narrow left rail + wide detail pane".
    // Shopify joins it: it gained an operator topbar and a sidebar panel on
    // 2026-08-10, and was briefly classified "page" from when it was a centred
    // column. A skeleton that outlives its layout paints the wrong frame, which
    // is worse than the blank it replaced.
    case "studio":
    case "shopify":
    // Live is master-detail: narrow roster rail + wide watch pane.
    case "live":
      return "rail";
    case "projects":
    case "workflow":
    case "feed":
    case "office":
    case "computer":
    case "recordings":
      return "grid";
    case "tasks":
    case "organization":
    case "association":
    case "crm":
    case "goals":
    case "approvals":
      return "list";
    // `p` and `inbox` (redirects to `/p`) land on the doc surface.
    // `apps` is one full-bleed pane under a chrome row (the custom-app frame),
    // which is the page shape too.
    case "p":
    case "inbox":
    case "apps":
      return "page";
  }
}

/**
 * Render the skeleton matching a surface. `chrome={false}` drops the `h-11`
 * chrome row for a pane that renders under a top bar the surface already
 * painted (Organization's sections load inside its hub).
 */
export function SurfaceSkeletonFor({
  surface,
  chrome = true,
}: {
  surface: WorkspaceSurface | null;
  chrome?: boolean;
}) {
  switch (surfaceSkeletonKind(surface)) {
    case "none":
      return null;
    case "brain":
      return <BrainSurfaceSkeleton />;
    case "rail":
      return <RailSurfaceSkeleton />;
    case "grid":
      return <GridSurfaceSkeleton chrome={chrome} />;
    case "list":
      return <ListSurfaceSkeleton chrome={chrome} />;
    case "page":
      return <PageSurfaceSkeleton />;
  }
}

/**
 * The chrome row every folded-in surface opens with (Brain / Studio topbars,
 * the operator topbar): 44px phone / 36px desktop, bottom-bordered, history on
 * the left, a breadcrumb, and trailing controls.
 */
function SurfaceChromeSkeleton({ trailing = 2 }: { trailing?: number }) {
  return (
    <div data-surface-chrome-skeleton className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border bg-background px-2 md:h-9 md:px-4">
      <Skeleton className="size-5 rounded-md" />
      <Skeleton className="size-5 rounded-md" />
      <Skeleton className="ml-1.5 h-3.5 w-28" />
      <div className="ml-auto flex items-center gap-1.5">
        {Array.from({ length: trailing }).map((_, i) => (
          <Skeleton key={i} className="size-5 rounded-md" />
        ))}
      </div>
    </div>
  );
}

/**
 * Doc page surface (`/p`) - chrome row, then the centered reading column:
 * icon + title block, then body paragraphs at the real `--doc-content-width`
 * measure. Used for document-shaped destinations; Home and Chat stay quiet.
 */
function PageSurfaceSkeleton({ chrome = true }: { chrome?: boolean }) {
  return (
    <div className="flex h-full w-full flex-col animate-fade-in">
      {chrome && <SurfaceChromeSkeleton trailing={3} />}
      <div className="flex-1 overflow-hidden px-4 pt-10 md:px-10 lg:px-16">
        <div className="doc-page-content space-y-6">
          <div className="space-y-3">
            <Skeleton className="size-9 rounded-lg" />
            <Skeleton className="h-8 w-2/3" />
          </div>
          <div className="space-y-2.5">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-[94%]" />
            <Skeleton className="h-3.5 w-[76%]" />
          </div>
          <div className="space-y-2.5">
            <Skeleton className="h-3.5 w-[88%]" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-[62%]" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Operator surfaces (Tasks, CRM) - chrome row, a filter strip, then dense
 * table rows on the shared 28px / flexible / trailing-columns grid.
 */
export function ListSurfaceSkeleton({
  rows = 9,
  chrome = true,
}: {
  rows?: number;
  /** Draw the `h-11` chrome row. OFF inside a surface that painted its own. */
  chrome?: boolean;
}) {
  return (
    <div className="flex h-full w-full flex-col animate-fade-in">
      {chrome && <SurfaceChromeSkeleton trailing={2} />}
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <Skeleton className="h-7 w-20 rounded-full" />
        <Skeleton className="h-7 w-24 rounded-full" />
        <Skeleton className="h-7 w-16 rounded-full" />
        <Skeleton className="ml-auto h-7 w-7 rounded-md" />
      </div>
      <div className="flex-1 overflow-hidden">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-3 border-b border-border/40 px-4 py-2.5"
          >
            <Skeleton className="size-4 shrink-0 rounded" />
            <Skeleton
              className="h-3.5"
              style={{ width: `${34 + ((i * 13) % 38)}%` }}
            />
            <Skeleton className="ml-auto hidden h-3.5 w-20 md:block" />
            <Skeleton className="hidden h-3.5 w-14 md:block" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Card-grid surfaces (Workflow, Decks, Recordings, Browsers) - chrome row,
 * a title + primary action, then the responsive card grid.
 */
export function GridSurfaceSkeleton({
  cards = 6,
  chrome = true,
  padded = chrome,
}: {
  cards?: number;
  /**
   * Draw the `h-11` chrome row. OFF when the skeleton renders inside a
   * surface layout that already painted its own topbar (Feed, Browsers) - a
   * second row there would stack two chromes.
   */
  chrome?: boolean;
  /**
   * Pad the pane. Separate from `chrome` because the two are not the same
   * question: Studio's layout pads its children (so a pane-only skeleton must
   * not pad again), while the Feed and Browsers shells hand children a bare
   * scroll container (so a pane-only skeleton MUST pad, or it sits flush
   * against the edges while the real content does not).
   */
  padded?: boolean;
}) {
  return (
    <div className="flex h-full w-full flex-col animate-fade-in">
      {chrome && <SurfaceChromeSkeleton trailing={1} />}
      <div
        className={cn("flex-1 overflow-hidden", padded && "px-4 pt-5 md:px-8")}
      >
        <div className="mb-5 flex items-center gap-3">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="ml-auto h-8 w-32 rounded-lg" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: cards }).map((_, i) => (
            <div
              key={i}
              className="space-y-3 rounded-xl border border-border bg-card p-4"
            >
              <div className="flex items-center gap-2.5">
                <Skeleton className="size-7 rounded-lg" />
                <Skeleton className="h-3.5 w-1/2" />
              </div>
              <div className="space-y-1.5">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-3/5" />
              </div>
              <div className="flex items-center gap-2 pt-0.5">
                <Skeleton className="h-4 w-16 rounded-md" />
                <Skeleton className="h-4 w-12 rounded-md" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Studio - chrome row, the `<md` section strip, then a settings-shaped pane of
 * stacked rows. The desktop section rail lives in the left sidebar, which the
 * persistent chrome already painted, so it is deliberately absent here.
 */
export function RailSurfaceSkeleton({
  rows = 5,
  chrome = true,
  padded = chrome,
}: {
  rows?: number;
  /**
   * Draw the `h-11` chrome row + mobile strip. OFF when the skeleton renders
   * inside `studio/layout.tsx`, which already painted both - this is the
   * section-to-section swap case, where only the pane is being replaced.
   */
  chrome?: boolean;
  /** Pad the pane - see the note on `GridSurfaceSkeleton`. */
  padded?: boolean;
}) {
  return (
    <div className="flex h-full w-full flex-col animate-fade-in">
      {chrome && (
        <>
          <SurfaceChromeSkeleton trailing={1} />
          <div className="flex items-center gap-1.5 border-b border-border px-4 py-2 md:hidden">
            <Skeleton className="h-8 w-24 rounded-lg" />
            <Skeleton className="h-8 w-20 rounded-lg" />
            <Skeleton className="h-8 w-24 rounded-lg" />
          </div>
        </>
      )}
      <div
        className={cn("flex-1 overflow-hidden", padded && "px-4 pt-4 md:px-8")}
      >
        <Skeleton className="mb-4 h-5 w-40" />
        <div className="space-y-2.5">
          {Array.from({ length: rows }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3.5"
            >
              <Skeleton className="size-8 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton
                  className="h-3.5"
                  style={{ width: `${28 + ((i * 17) % 34)}%` }}
                />
                <Skeleton className="h-3 w-2/3" />
              </div>
              <Skeleton className="h-7 w-20 shrink-0 rounded-md" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Brain - chrome row, the compact filter strip, then the skeleton-color-only
 * force-graph facsimile shared with the live canvas. Circular nodes, label
 * bars, and fine edges match the finished graph's visual grammar.
 */
export function BrainSurfaceSkeleton() {
  return (
    <div className="flex h-full w-full flex-col animate-fade-in">
      <SurfaceChromeSkeleton trailing={3} />
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <Skeleton className="h-7 w-44 rounded-md" />
        <Skeleton className="h-7 w-16 rounded-md" />
        <Skeleton className="ml-auto h-7 w-24 rounded-md" />
      </div>
      <div className="relative flex-1 overflow-hidden">
        <BrainGraphLoadingSkeleton />
      </div>
    </div>
  );
}

/**
 * The whole app frame - persistent sidebar plus a page-shaped surface.
 *
 * This is the COLD-LOAD fallback (`app/w/loading.tsx`), the one case where the
 * chrome itself is not on screen yet: the `/w/[workspaceId]` layout is an async
 * server component that awaits the workspace fetch, so until it resolves there
 * is no sidebar to render a surface skeleton inside. Without a boundary above
 * that layout the browser shows the previous page (or white) for the whole
 * round trip. Drawing the frame here means a hard refresh paints the app's
 * silhouette immediately and then fills in.
 */
export function AppShellSkeleton() {
  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-sidebar-accent/40 animate-fade-in">
      <div data-workspace-window-header className="[&>div]:border-transparent [&>div]:bg-transparent">
        <SurfaceChromeSkeleton trailing={3} />
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div aria-hidden className="hidden h-full w-14 shrink-0 flex-col items-center gap-1 px-2 pt-[13px] md:flex">
          <div className="flex h-16 w-full shrink-0 items-center justify-center"><Skeleton className="size-7 rounded-lg" /></div>
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="size-9 rounded-xl" />)}
        </div>
        <aside aria-hidden data-doc-context-sidebar className="doc-sidebar-surface mb-2 mt-3 hidden h-[calc(100%-1.25rem)] w-56 shrink-0 flex-col rounded-l-2xl border-y border-l border-r border-sidebar-border md:flex">
          <div className="flex h-16 shrink-0 items-center gap-1 px-4">
            <Skeleton className="h-3.5 w-28" />
          </div>
          <div className="space-y-2 p-2">
            {Array.from({ length: 9 }).map((_, i) => (
              <Skeleton
                key={i}
                className="h-6 rounded-md"
                style={{ width: `${52 + ((i * 11) % 44)}%` }}
              />
            ))}
          </div>
        </aside>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background md:mb-2 md:mt-3 md:mr-2 md:pt-2 md:rounded-r-2xl md:border-y md:border-r md:border-border">
          <PageSurfaceSkeleton chrome={false} />
        </div>
      </div>
    </div>
  );
}
