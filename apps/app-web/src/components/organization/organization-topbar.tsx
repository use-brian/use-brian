"use client";

/**
 * Organization top bar: the shared operator top bar with an Organization
 * identity chip, a section switcher fallback and the right-slot action target.
 *
 *   [ ☰ ] [ ‹ ] [ › ]  ▣ Organization  Structure · {summary}      {actions}
 *
 * The center names the active section while the sidebar is open (the sidebar
 * panel is the switcher then). When the sidebar is unavailable it becomes the
 * switcher: a compact section menu on phones and beside a collapsed desktop sidebar,
 * preserving space for the section actions. Sections fill the right slot through
 * `OrganizationTopbarActions`.
 *
 * Spec: docs/architecture/features/organization-chart.md → "User experience".
 * [COMP:app-web/organization-chart]
 */
import {useWorkspaceAccessMode} from "@/components/context/mode-aware-context";
import {visibleOrganizationSections} from "@/lib/organization-navigation";
import { useRouter } from 'next/navigation';
import { Check, ChevronDown, Users } from 'lucide-react';
import { OperatorTopbar } from '@/components/operator/operator-topbar';
import { useSidebarData } from '@/components/doc/doc-sidebar-data';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';
import { organizationHref, type OrganizationSection } from '@/lib/organization-navigation';
import { ORGANIZATION_SECTION_ICON, organizationSectionCopy } from './organization-chrome';

export function OrganizationTopbar({ workspaceId, section, slotRef }: {
  workspaceId: string;
  section: OrganizationSection;
  slotRef: (element: HTMLDivElement | null) => void;
}) {
  const mode=useWorkspaceAccessMode();
  const sections=visibleOrganizationSections(mode.data);
  const t = useT().organization;
  const copy = organizationSectionCopy(t);
  const { sidebarCollapsed } = useSidebarData();
  const router = useRouter();
  const ActiveIcon = ORGANIZATION_SECTION_ICON[section];
  return <OperatorTopbar
    identity={{ label: t.title, icon: Users }}
    center={<>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label={t.sectionsAriaLabel} data-organization-section-menu
          className={cn("inline-flex h-11 min-w-0 max-w-44 items-center gap-1.5 rounded-md bg-sidebar-accent/60 px-2.5 text-[13px] font-medium text-sidebar-accent-foreground md:h-7", !sidebarCollapsed && "md:hidden")}>
          <ActiveIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{copy[section].label}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {sections.map(item => {
            const Icon = ORGANIZATION_SECTION_ICON[item];
            return <DropdownMenuItem key={item} className={cn('min-h-8 max-sm:min-h-11', item === section && 'font-medium')} onClick={() => router.push(organizationHref(workspaceId, item))}>
              <Icon className="size-3.5" aria-hidden /><span className="min-w-32 flex-1">{copy[item].label}</span>{item===section?<Check className="size-3.5" aria-hidden />:null}
            </DropdownMenuItem>;
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {!sidebarCollapsed ? <p data-organization-section-title className="hidden min-w-0 truncate text-[13px] md:block">
        <span className="font-medium text-sidebar-foreground">{copy[section].label}</span>
        <span className="text-sidebar-foreground/55"> · {copy[section].summary}</span>
      </p> : null}
    </>}
    right={<div ref={slotRef} data-organization-actions className="flex items-center gap-1" />}
  />;
}
