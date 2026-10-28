"use client";

/** Route-backed setup views shared by the contextual panel and compact top bar.
 * Spec: docs/architecture/features/workspace-navigation.md → "Projects and Organization".
 * [COMP:app-web/workspace-structure-switcher] */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronDown } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { useIntentPrefetch } from "@/lib/surface-prefetch";
import { requestSidebarClose } from "@/lib/sidebar-close";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export function WorkspaceStructureSwitcher({ workspaceId, view, compact = false }: {
  workspaceId: string;
  view: "projects" | "organization";
  compact?: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const prefetch = useIntentPrefetch();
  const views = [
    { id: "projects", label: t.contextScope.projectsTitle },
    { id: "organization", label: t.organization.title },
  ] as const;
  const href = (id: typeof view) => `/w/${workspaceId}/${id}`;

  if (compact) return <DropdownMenu>
    <DropdownMenuTrigger aria-label={t.workspaceNav.projectsAndOrganization} data-workspace-structure-menu
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-sidebar-accent max-md:h-11">
      <span>{views.find(item => item.id === view)!.label}</span><ChevronDown className="size-3.5 shrink-0" aria-hidden />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start">
      {views.map(item => <DropdownMenuItem key={item.id} className="max-md:min-h-11" onClick={() => { router.push(href(item.id)); requestSidebarClose(); }}>
        <span className="flex-1">{item.label}</span>{item.id === view && <Check className="size-4" aria-hidden />}
      </DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;

  return <nav aria-label={t.workspaceNav.projectsAndOrganization} data-workspace-structure-switcher className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-sidebar-accent/50 p-1">
    {views.map(item => <Link key={item.id} href={href(item.id)} {...prefetch(href(item.id))}
      onClick={requestSidebarClose} aria-current={item.id === view ? "page" : undefined}
      className={cn("flex min-h-8 min-w-0 items-center justify-center rounded-md px-1.5 py-1.5 text-center text-xs transition-colors max-md:min-h-11",
        item.id === view ? "bg-background font-medium text-sidebar-accent-foreground shadow-sm" : "text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground")}>
      {item.label}
    </Link>)}
  </nav>;
}
