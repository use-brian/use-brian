"use client";

/** Canonical project records and explicit fresh-chat launch. [COMP:app-web/project-content] */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Skeleton } from "@/components/skeleton";
import { useT } from "@/lib/i18n/client";
import { getProjectContent, type ContextProject, type ProjectContentView } from "@/lib/api/context-scopes";
import { useCachedResource } from "@/lib/surface-cache";
import { projectContentCacheKey } from "@/lib/surface-prefetch";
import { workspaceSearchHref } from "@/lib/workspace-search-navigation";
import { personalChatHandoffPath, stashChatHandoff } from "@/lib/chat-handoff";

export function ProjectContent({ project, assistants }: {
  project: ContextProject; assistants: Array<{ id: string; name: string }>;
}) {
  const t = useT().contextScope;
  const copy = t.projectHome;
  const router = useRouter();
  const [view, setView] = useState<ProjectContentView>("work");
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [pickedAssistant, setPickedAssistant] = useState("");
  const assistantId = assistants.some(row => row.id === pickedAssistant) ? pickedAssistant : assistants[0]?.id ?? "";
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(input.trim()); setOffset(0); }, 250);
    return () => clearTimeout(timer);
  }, [input]);
  const content = useCachedResource(projectContentCacheKey(project.workspaceId, project.id, view, query, offset),
    () => getProjectContent(project.workspaceId, project.id, view, query, offset), {expiresInMs: () => 60_000});
  function ask(text: string) {
    if (!assistantId || project.status !== "active") return;
    const requestId = stashChatHandoff({workspaceId: project.workspaceId, assistantId,
      contextProjectId: project.id, draftOnly: true, text, ts: Date.now()});
    if (requestId) router.push(personalChatHandoffPath(project.workspaceId, assistantId, requestId));
  }
  return <>
    <section className="rounded-xl border border-border bg-muted/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">{copy.ask}</h2>
        <SearchableSelect value={assistantId} onValueChange={setPickedAssistant}
          items={assistants.map(row => ({value: row.id, label: row.name}))}
          aria-label={t.projectDetailAssistants} placeholder={copy.chooseAssistant}
          searchPlaceholder={copy.chooseAssistant} emptyMessage={t.projectDetailEmptyAssistants}
          className="w-full sm:w-56" disabled={project.status === "archived" || !assistants.length} />
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{project.status === "archived" ? copy.archivedChat : copy.chatHint}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {[copy.next, copy.blockers, copy.changes].map(prompt => <Button key={prompt} variant="outline"
          className="max-sm:min-h-11 h-auto whitespace-normal text-left" disabled={!assistantId || project.status === "archived"}
          onClick={() => ask(`${prompt}\n\n${copy.cite}`)}>{prompt}</Button>)}
      </div>
    </section>
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label={t.projectDetailOverview} className="flex gap-1">
          {(["work", "knowledge", "recent"] as const).map(tab => <Button key={tab} aria-pressed={view === tab}
            variant={view === tab ? "secondary" : "ghost"} className="max-sm:min-h-11"
            onClick={() => {setView(tab); setOffset(0);}}>{copy[tab]}</Button>)}
        </div>
        <input type="search" value={input} onChange={event => setInput(event.target.value)} maxLength={200}
          aria-label={copy.search} placeholder={copy.search}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-base sm:w-64 sm:text-sm max-sm:min-h-11" />
      </div>
      <p className="text-sm text-muted-foreground">{view === "recent" ? copy.recentHint : copy.contentHint}</p>
      {content.error ? <div role="alert" className="rounded-xl border border-border p-4">
        <p>{t.loadFailed}</p><Button variant="outline" className="mt-2 max-sm:min-h-11" onClick={() => void content.refresh()}>{t.retryProjects}</Button>
      </div> : content.loading && !content.data ? <div aria-busy="true" className="space-y-3">
        {[0,1,2].map(i => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
      </div> : content.data?.items.length ? <ul className="divide-y divide-border rounded-xl border border-border">
        {content.data.items.map(item => <li key={item.key}>
          <Link href={workspaceSearchHref(project.workspaceId, item.target)} className="block space-y-2 p-4 hover:bg-muted/40 focus-visible:outline-ring">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="break-words font-medium">{item.title || copy.untitled}</span>
              <span className="text-xs text-muted-foreground">{copy.kinds[item.kind as keyof typeof copy.kinds] ?? copy.work}
                {item.kind === "tasks" && item.status && item.status in copy.statuses ? ` · ${copy.statuses[item.status as keyof typeof copy.statuses]}` : ""}</span>
            </div>
            {item.snippet ? <p className="line-clamp-2 break-words text-sm text-muted-foreground">{item.snippet}</p> : null}
            {item.updatedAt ? <time dateTime={item.updatedAt} className="block text-xs text-muted-foreground">{new Date(item.updatedAt).toLocaleDateString()}</time> : null}
          </Link>
        </li>)}
      </ul> : <div className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
        <p>{query ? copy.noMatches : copy.empty}</p><p className="mt-2">{copy.attachHint}</p>
      </div>}
      <div className="flex justify-between gap-3">
        {offset > 0 ? <Button variant="outline" className="max-sm:min-h-11" onClick={() => setOffset(Math.max(0, offset-30))}>{copy.previous}</Button> : <span />}
        {!content.error && content.data?.nextOffset != null ? <Button variant="outline" className="max-sm:min-h-11" onClick={() => setOffset(content.data!.nextOffset!)}>{copy.more}</Button> : null}
      </div>
    </section>
  </>;
}
