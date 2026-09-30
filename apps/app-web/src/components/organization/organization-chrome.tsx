"use client";

/**
 * Organization chrome primitives shared by the top bar, the sidebar panel and
 * the sections: section icons + copy, the top-bar action slot, and the
 * right-slot button recipes. Deliberately free of the top bar itself so a
 * section can declare actions without importing the chrome.
 *
 * Spec: docs/architecture/features/organization-chart.md → "User experience".
 * [COMP:app-web/organization-chart]
 */
import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Building2, Network, ShieldCheck, UsersRound, type LucideIcon } from 'lucide-react';
import type { Dictionary } from '@/lib/i18n/dictionaries/en';
import type { OrganizationSection } from '@/lib/organization-navigation';

export const ORGANIZATION_SECTION_ICON: Record<OrganizationSection, LucideIcon> = {
  structure: Network,
  people: UsersRound,
  departments: Building2,
  access: ShieldCheck,
};

export function organizationSectionCopy(t: Dictionary['organization']): Record<OrganizationSection, { label: string; summary: string }> {
  return {
    structure: { label: t.structureTab, summary: t.structureSummary },
    people: { label: t.peopleTab, summary: t.peopleSummary },
    departments: { label: t.departmentsTab, summary: t.departmentsSummary },
    access: { label: t.accessTab, summary: t.accessSummary },
  };
}

/** Primary action in the top bar: icon-only 44px square on phones (M3). */
export const organizationTopbarPrimaryCls =
  'inline-flex size-11 shrink-0 items-center justify-center gap-1.5 rounded-md bg-action text-sm font-medium text-action-foreground shadow-sm transition-colors hover:bg-action/85 disabled:pointer-events-none disabled:opacity-50 sm:h-8 sm:w-auto sm:px-2.5';
/** Secondary action in the top bar, in the Tasks right-slot recipe. */
export const organizationTopbarActionCls =
  'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground aria-pressed:bg-sidebar-accent aria-pressed:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 max-sm:w-11 max-sm:justify-center max-sm:px-0 sm:h-7';

/** `undefined` = rendered outside the hub; `null` = hub slot not mounted yet. */
const OrganizationTopbarSlotContext = createContext<HTMLElement | null | undefined>(undefined);
export const OrganizationTopbarSlotProvider = OrganizationTopbarSlotContext.Provider;

/** Render a section's actions in the Organization top bar, or inline when the section is used on its own. */
export function OrganizationTopbarActions({ children }: { children: ReactNode }) {
  const slot = useContext(OrganizationTopbarSlotContext);
  if (slot === undefined) return <div className="flex flex-wrap items-center gap-2">{children}</div>;
  return slot ? createPortal(children, slot) : null;
}
