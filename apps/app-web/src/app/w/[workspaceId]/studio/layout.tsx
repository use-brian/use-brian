"use client";

/**
 * Studio shell (app-web) — the doc-style `StudioTopbar`, a `<md` mobile
 * section strip, and the section page pane, in one scroll container.
 *
 * Ported from `apps/web/src/app/(app)/studio/layout.tsx` as part of the app
 * consolidation (docs/architecture/features/doc.md §9 #5 — Studio
 * unified in app-web with its OWN full-page layout/sub-nav, NOT the doc
 * three-column page shell). The persistent `/w/[workspaceId]` layout `<main>`
 * hosts this shell.
 *
 * Surface-aware sidebar refactor: the DESKTOP grouped section rail now lives in
 * the left sidebar (`StudioSidebarPanel`, shown when the active surface is
 * Studio) — so the sidebar body is contextual rather than always the page tree.
 * This shell keeps the `<md` horizontally-scrollable tab strip (the sidebar is
 * a slide-in drawer on mobile, so the section nav still needs an inline home
 * there) and the page pane. Both the strip and the sidebar rail read the one
 * `STUDIO_GROUPS` definition (`lib/studio-nav.ts`) so they can't drift.
 *
 * The `StudioTopbar` ([COMP:app-web/studio-topbar]) is the doc-style chrome
 * row above everything — sidebar collapse, history arrows, the
 * "Studio / {section}" breadcrumb — sticky inside this shell's one scroll
 * container, mirroring the Brain surface.
 *
 * Spec: docs/architecture/features/studio.md.
 * [COMP:app-web/studio-shell]
 */

import Link from "next/link";
import { usePathname, useParams } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { ScrollableNav } from "@/components/scrollable-nav";
import { StudioTopbar } from "@/components/studio/studio-topbar";
import { useWorkspaceFetch } from "@/contexts/workspace-context";
import { visibleStudioGroups } from "@/lib/studio-nav";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  const t = useT();
  const pathname = usePathname() ?? "";
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  const hrefFor = (segment: string) => `/w/${workspaceId}/studio/${segment}`;

  // Populate the shared workspace-list cache so Studio surfaces that read the
  // full `useWorkspaces().active` (e.g. Connectors needs `active.memberCount`
  // to gate the "Share with workspace" control on shared-vs-solo) resolve. The
  // route-scoped `useWorkspaceContext()` provides only id/name/role; the list
  // is fetched once per app load. See `@/contexts/workspace-context`.
  useWorkspaceFetch(API_URL);

  return (
    <div className="h-full w-full overflow-y-auto flex flex-col">
      {/* Doc-style chrome row — sticky at the top of this scroll container,
          mirroring the Brain surface. */}
      <StudioTopbar workspaceId={workspaceId} />

      {/* Mobile rail — horizontally scrollable tab strip with inline
          group headers between blocks. The desktop grouped rail lives in the
          left sidebar (`StudioSidebarPanel`); this strip is the `<md` fallback
          since the sidebar is a slide-in drawer on mobile. */}
      <div className="md:hidden border-b border-border px-4 pb-2 pt-1">
        <ScrollableNav>
          <nav aria-label={t.studioPage.sectionsAriaLabel} className="flex items-center gap-0.5">
            {visibleStudioGroups().map((g, gi) => (
              <div key={g.key} className="flex items-center gap-0.5">
                {gi > 0 && <span className="text-muted-foreground/30 px-1.5">·</span>}
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground/70 px-1.5 select-none">
                  {t.studioPage.groups[g.key]}
                </span>
                {g.sections.map((s) => {
                  const href = hrefFor(s.segment);
                  const active = pathname.startsWith(href);
                  return (
                    <Link
                      key={s.key}
                      href={href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "block whitespace-nowrap px-3 py-2 rounded-lg text-[14px] transition-colors",
                        active
                          ? "bg-muted text-foreground font-medium"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                      )}
                    >
                      {t.studioPage.sections[s.key]}
                    </Link>
                  );
                })}
              </div>
            ))}
          </nav>
        </ScrollableNav>
      </div>

      {/* Section page pane — the page owns its own internal layout. Tighter
          horizontal padding on mobile so content has room to breathe.
          pb-28 reserves room for the fixed "Ask anything" chat dock the
          workspace chrome floats over this surface's bottom-right, so a
          page's last row (often a Save action) can scroll clear of it. */}
      <div className="w-full flex-1 px-4 pt-4 pb-28 md:px-8">{children}</div>
    </div>
  );
}
