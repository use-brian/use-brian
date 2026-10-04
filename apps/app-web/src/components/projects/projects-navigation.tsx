"use client";

/** Shared project destinations for the sidebar and compact top bar. [COMP:app-web/projects-navigation] */
import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Check, ChevronDown, FolderKanban } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { useCachedResource } from "@/lib/surface-cache";
import { surfaceDataKey } from "@/lib/surface-prefetch";
import { listContextProjects } from "@/lib/api/context-scopes";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/skeleton";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

function useProjectsNavigation(workspaceId: string) {
  const t = useT().contextScope;
  const path = usePathname();
  const base = `/w/${workspaceId}/projects`;
  const resource = useCachedResource(surfaceDataKey("projects", workspaceId), () => listContextProjects(workspaceId, true));
  const items = (resource.data ?? []).map(project => ({
    id: project.id, label: project.name, href: `${base}/${project.id}`, archived: project.status === "archived",
  }));
  const active = items.find(item => path === item.href);
  return { t, base, path, resource, items, active };
}

export function ProjectsSidebarPanel({ workspaceId }: { workspaceId: string }) {
  const {t, base, path, resource, items} = useProjectsNavigation(workspaceId);
  const [query, setQuery] = useState("");
  const filtered = items.filter(item => item.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const row = (href: string, label: string) => <Link key={href} href={href} aria-current={path === href ? "page" : undefined}
    title={label} className={cn("flex min-h-10 items-center gap-2 rounded-md px-3 py-2 text-sm max-md:min-h-11",
      path === href ? "doc-nav-active font-medium text-sidebar-accent-foreground" : "text-sidebar-foreground/80 hover:bg-sidebar-accent")}>
    <FolderKanban className="size-4 shrink-0" aria-hidden /><span className="min-w-0 truncate">{label}</span>
  </Link>;
  return <nav aria-label={t.projectsTitle} className="space-y-3">
    {row(base,t.allProjects)}
    <input type="search" aria-label={t.searchProjects} placeholder={t.searchProjects} value={query} onChange={event=>setQuery(event.target.value)}
      className="h-9 w-full rounded-md border border-sidebar-border bg-transparent px-3 text-base md:text-sm max-md:h-11" />
    {resource.error ? <div role="alert" className="px-3 text-sm"><p>{t.loadFailed}</p><Button variant="ghost" className="max-md:min-h-11" onClick={()=>void resource.refresh()}>{t.retryProjects}</Button></div>
      : resource.loading && !resource.data ? <div aria-busy="true" className="space-y-2">{[0,1,2].map(i=><Skeleton key={i} className="h-10 w-full" />)}</div>
      : filtered.length ? [false,true].map(archived=>{
        const group=filtered.filter(item=>item.archived===archived);
        return group.length ? <div key={String(archived)}><p className="px-3 pb-1 text-xs text-sidebar-foreground/50">{archived?t.archived:t.active}</p>
          {group.map(item=>row(item.href,item.label))}</div> : null;
      }) : <p className="px-3 text-sm text-sidebar-foreground/60">{query?t.noMatchingProjects:t.noProjects}</p>}
  </nav>;
}

export function ProjectsTopbar() {
  const {workspaceId}=useWorkspaceContext();
  const {t,base,path,resource,items,active}=useProjectsNavigation(workspaceId);
  const router=useRouter();
  const label=active?.label ?? (path===base?t.allProjects:t.projectsTitle);
  return <OperatorTopbar identity={{label:t.projectsTitle,icon:FolderKanban}} center={
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={t.switchProject} title={label}
        className="inline-flex h-8 min-w-0 max-w-64 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-sidebar-accent max-md:h-11">
        <span className="truncate">{label}</span><ChevronDown className="size-3.5 shrink-0" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60dvh] w-64 max-w-[calc(100vw-2rem)] overflow-y-auto">
        <DropdownMenuItem onClick={()=>router.push(base)} className="max-md:min-h-11">
          <span className="flex-1">{t.allProjects}</span>{path===base?<Check className="size-4" aria-hidden />:null}
        </DropdownMenuItem>
        {resource.error ? <DropdownMenuItem onClick={()=>void resource.refresh()} className="max-md:min-h-11">{t.retryProjects}</DropdownMenuItem>
          : resource.loading && !resource.data ? <Skeleton className="m-2 h-8 w-40" />
          : items.map(item=><DropdownMenuItem key={item.id} title={item.label} onClick={()=>router.push(item.href)} className="max-md:min-h-11">
            <span className="min-w-0 flex-1 truncate">{item.label}{item.archived?` (${t.archived})`:""}</span>
            {item.id===active?.id?<Check className="size-4 shrink-0" aria-hidden />:null}
          </DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  } />;
}
