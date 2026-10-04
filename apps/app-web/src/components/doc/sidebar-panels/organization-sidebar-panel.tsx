"use client";

/**
 * Organization sidebar panel — the desktop section switcher, rendered in the
 * left sidebar while the Organization surface is active. Section rows use the
 * Brain / CRM row recipe (`.doc-nav-active`, no primary blue) and link to the
 * canonical `?section=` destinations from `lib/organization-navigation.ts`.
 * The `<md` / collapsed-sidebar fallback is the switcher in the Organization
 * top bar, which reads the same section list so the two cannot drift.
 *
 * Spec: docs/architecture/features/organization-chart.md → "User experience".
 * [COMP:app-web/sidebar-panel-organization]
 */

import {useWorkspaceAccessMode} from "@/components/context/mode-aware-context";
import {visibleOrganizationSections} from "@/lib/organization-navigation";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import {
  organizationHref,
  organizationSection,
} from "@/lib/organization-navigation";
import {
  ORGANIZATION_SECTION_ICON,
  organizationSectionCopy,
} from "@/components/organization/organization-chrome";

export function OrganizationSidebarPanel({ workspaceId }: { workspaceId: string }) {
  const mode=useWorkspaceAccessMode();
  const sections=visibleOrganizationSections(mode.data);
  const t = useT().organization;
  const copy = organizationSectionCopy(t);
  const active = organizationSection(useSearchParams()?.get("section") ?? null);

  return (
    <nav aria-label={t.sectionsAriaLabel} className="flex flex-col gap-1">

      {sections.map((section) => {
        const Icon = ORGANIZATION_SECTION_ICON[section];
        const current = section === active;
        return (
          <Link
            key={section}
            href={organizationHref(workspaceId, section)}
            aria-current={current ? "page" : undefined}
            title={copy[section].summary}
            className={cn(
              "flex w-full items-center min-h-10 gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors max-md:min-h-11",
              current
                ? "doc-nav-active font-medium text-sidebar-accent-foreground"
                : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            )}
          >
            <Icon className="size-[18px] shrink-0 text-sidebar-foreground/60" aria-hidden />
            <span className="min-w-0 truncate">{copy[section].label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
