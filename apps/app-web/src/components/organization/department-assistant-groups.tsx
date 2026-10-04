"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { AssistantAvatar } from "@/components/assistant-avatar";
import { useT } from "@/lib/i18n/client";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { listAssistants, type StudioAssistantSummary } from "@/lib/api/studio";
import { DEPARTMENTS_CHANGED_EVENT } from "@/lib/api/departments";
import { useCachedResource, invalidateSurfaceCache } from "@/lib/surface-cache";
import { assistantsCacheKey } from "@/lib/surface-prefetch";

/** Placement directory, using the authorized Studio roster. [COMP:app-web/department-assistants] */
export function DepartmentAssistantGroups() {
  const { workspaceId } = useWorkspaceContext();
  const t = useT().studioPage.assistants;
  const cacheKey = assistantsCacheKey(workspaceId);
  const resource = useCachedResource(cacheKey, () => listAssistants(workspaceId));
  useEffect(() => {
    const refresh = (event: Event) => {
      const target = (event as CustomEvent<{ workspaceId?: string }>).detail?.workspaceId;
      if (!target || target === workspaceId) invalidateSurfaceCache(cacheKey);
    };
    window.addEventListener(DEPARTMENTS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(DEPARTMENTS_CHANGED_EVENT, refresh);
  }, [workspaceId, cacheKey]);
  const groups = new Map<string, { name: string; assistants: StudioAssistantSummary[] }>();
  for (const assistant of resource.data ?? []) {
    const id = assistant.placementDepartmentId ?? "workspace";
    const group = groups.get(id) ?? { name: id === "workspace" ? t.placementWorkspace : assistant.placementDepartmentName ?? t.placementDepartment, assistants: [] };
    group.assistants.push(assistant);
    groups.set(id, group);
  }
  const ordered = [...groups].sort(([a, ga], [b, gb]) => a === "workspace" ? -1 : b === "workspace" ? 1 : ga.name.localeCompare(gb.name));
  return <section className="space-y-3" aria-label={t.departmentGroupsTitle}>
    <div><h2 className="text-base font-semibold">{t.departmentGroupsTitle}</h2><p className="mt-1 text-sm text-muted-foreground">{t.departmentGroupsHint}</p></div>
    {!resource.data ? <div aria-hidden className="h-24 animate-pulse rounded-xl bg-muted/40" /> : !ordered.length ? <p className="text-sm text-muted-foreground">{t.empty}</p> :
      <div className="divide-y rounded-xl border border-border">{ordered.map(([id, group]) => <AssistantGroup key={id} name={group.name} assistants={group.assistants} workspaceId={workspaceId} />)}</div>}
  </section>;
}

function AssistantGroup({ name, assistants, workspaceId }: { name: string; assistants: StudioAssistantSummary[]; workspaceId: string }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return <div>
    <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)} className="flex min-h-8 max-sm:min-h-11 w-full items-center gap-2 px-4 py-3 text-left hover:bg-muted/40">
      <ChevronRight aria-hidden className={`size-4 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
      <span className="rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums">{assistants.length}</span>
    </button>
    <ul id={id} hidden={!expanded} className="space-y-1 px-4 pb-3">
      {assistants.map(assistant => <li key={assistant.id}><Link href={`/w/${encodeURIComponent(workspaceId)}/studio/assistants?assistant=${encodeURIComponent(assistant.id)}`} className="flex min-h-8 max-sm:min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-muted/50">
        <AssistantAvatar id={assistant.id} name={assistant.name} iconSeed={assistant.iconSeed ?? 0} size="sm" />
        <span className="truncate">{assistant.name}</span>
      </Link></li>)}
    </ul>
  </div>;
}
