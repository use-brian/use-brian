"use client";

/**
 * Studio sidebar panel — the grouped section sub-menu, rendered in the left
 * sidebar when the active surface is Studio (consolidation: the sidebar body is
 * surface-aware; the page tree is Home-only).
 *
 * This is the desktop counterpart of the `<md` mobile tab strip that
 * `studio/layout.tsx` still renders — both read the one `STUDIO_GROUPS`
 * definition (`lib/studio-nav.ts`) so the two nav surfaces can't drift. The
 * Studio layout's right pane is unchanged; only its desktop rail moved here.
 *
 * [COMP:app-web/sidebar-panel-studio]
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { STUDIO_GROUPS } from "@/lib/studio-nav";

export function StudioSidebarPanel({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const pathname = usePathname() ?? "";
  const hrefFor = (segment: string) => `/w/${workspaceId}/studio/${segment}`;

  return (
    <nav
      aria-label={t.studioPage.sectionsAriaLabel}
      className="flex flex-col gap-4 px-1 pt-1"
    >
      {STUDIO_GROUPS.map((g) => (
        <div key={g.key} className="flex flex-col gap-0.5">
          <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45">
            {t.studioPage.groups[g.key]}
          </div>
          <ul className="flex flex-col gap-0.5">
            {g.sections.map((s) => {
              const href = hrefFor(s.segment);
              const active = pathname.startsWith(href);
              return (
                <li key={s.key}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block w-full rounded-md px-2 py-1.5 text-sm transition-colors",
                      active
                        ? "doc-nav-active font-medium text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    )}
                  >
                    {t.studioPage.sections[s.key]}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
