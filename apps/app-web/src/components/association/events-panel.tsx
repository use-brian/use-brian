"use client";

/** Website event index and direct entry to the single event workspace. [COMP:app-web/association] */
import { useState } from "react";
import { CalendarDays, Plus } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { getSiteContentDraft, type AssociationEvent, type EventPagesDocument } from "@/lib/api/association";
import { useCachedResource } from "@/lib/surface-cache";
import { associationPageCacheKey } from "@/lib/surface-prefetch";
import { Button } from "@/components/ui/button";
import { useAssociationModule } from "./module-controls";
import { ReadOnlyNotice } from "./access";
import { AssociationListState, useAssociationPage } from "./operator-controls";
import { AssociationEventForm } from "./catalog-forms";
import { AssociationEditor } from "./workspace-ui";
import { AssociationEventDetail } from "./event-detail";
import { sameEventPage } from "./events/event-page-editor";
import { EmptyState, InlineNotice, PageHeader, ResponsiveTable, Segmented, StatusPill, associationDate } from "./ui";

type EventView = "website" | "drafts" | "all";
export function eventWhere(event: AssociationEvent, labels: { venue: string; online: string; hybrid: string }): string {
  return event.mode === "online" ? labels.online : event.venue || labels[event.mode];
}

export function AssociationEventsPanel({ workspaceId, initialEventId = "", initialEventSlug = "", initialNew = false }: { workspaceId: string; initialEventId?: string; initialEventSlug?: string; initialNew?: boolean }) {
  const t = useT().associationPage, u = t.ux, m = t.manage, e = t.eventPage;
  const [view, setView] = useState<EventView>("website");
  // Visibility is filtered before cursor pagination, including past/cancelled public archives.
  const rows = useAssociationPage(workspaceId, "events", view === "website" ? { website: "visible" } : view === "drafts" ? { website: "drafts" } : {});
  const access = useAssociationModule(workspaceId);
  const configure = !!access.data?.canManage && !access.error, enabled = access.data?.module.state === "enabled" && !access.error;
  const pages = useCachedResource(configure ? associationPageCacheKey(workspaceId, "site-content:event-pages") : null, () => getSiteContentDraft(workspaceId, "event-pages"));
  const [selectedId, setSelectedId] = useState<string | null>(initialEventId || null);
  const [dismissedLink, setDismissedLink] = useState(false);
  const [created, setCreated] = useState<AssociationEvent | null>(null);
  const [creating, setCreating] = useState(initialNew);
  // Resolve every selection directly, including newly created drafts outside the current list.
  const direct = useAssociationPage(workspaceId, "events", selectedId ? { id: selectedId } : { slug: initialEventSlug }, !!(selectedId || (!dismissedLink && initialEventSlug)));
  const selected = selectedId
    ? direct.data?.items.find(row => row.id === selectedId) ?? rows.data?.items.find(row => row.id === selectedId) ?? (created?.id === selectedId ? created : null)
    : !dismissedLink && initialEventSlug ? direct.data?.items.find(row => row.slug === initialEventSlug) ?? null : null;
  function pageChanged(event: AssociationEvent) {
    const saved = (pages.data?.document as EventPagesDocument | null)?.pages.find(page => page.event === event.slug);
    const published = (pages.data?.published as EventPagesDocument | null)?.pages.find(page => page.event === event.slug);
    return !sameEventPage(saved ?? null, published ?? null);
  }
  if (creating) return <AssociationEditor title={m.newEvent} onClose={() => setCreating(false)}>
    <InlineNotice tone="neutral">{e.createHelp}</InlineNotice>
    <AssociationEventForm workspaceId={workspaceId} disabled={!configure || !!rows.error} onSaved={record => {
      setCreated(record); setSelectedId(record.id); setCreating(false); void rows.refresh();
    }} />
  </AssociationEditor>;
  if (selected) return <AssociationEventDetail key={selected.id} workspaceId={workspaceId} event={selected} enabled={enabled} canManage={configure} loadFailed={!!direct.error}
    onBack={() => { setSelectedId(null); setDismissedLink(true); }} onChanged={() => { void rows.refresh(); void direct.refresh(); }} />;
  if ((selectedId || (!dismissedLink && initialEventSlug)) && !direct.data && !direct.error) return <AssociationListState {...direct}><span /></AssociationListState>;
  return <section className="space-y-5">
    <PageHeader title={u.eventsNav} description={configure ? e.indexHelp : u.eventsHelp} actions={configure ? <Button type="button" className="min-h-11 md:min-h-9" disabled={!!rows.error} onClick={() => setCreating(true)}><Plus aria-hidden className="size-4" />{m.newEvent}</Button> : undefined}>
      <Segmented label={u.filters} value={view} onChange={setView} options={[{ value: "website", label: e.onWebsite }, { value: "drafts", label: u.drafts }, { value: "all", label: e.allEvents }]} />
      <p className="text-sm text-muted-foreground">{view === "drafts" ? e.draftsHelp : e.websiteHelp}</p>
    </PageHeader>
    {direct.error ? <InlineNotice tone="danger">{m.loadFailed}</InlineNotice> : null}
    {pages.error ? <InlineNotice tone="warning">{e.statusUnavailable}</InlineNotice> : null}
    {access.data && !configure ? <ReadOnlyNotice /> : null}
    {access.data && access.data.module.state !== "enabled" ? <InlineNotice tone="warning">{t.stateDescriptions[access.data.module.state]}</InlineNotice> : null}
    <AssociationListState {...rows}>
      <ResponsiveTable rows={rows.data?.items ?? []} rowKey={row => row.id} rowData={row => ({ "data-event-row": row.id })} onRowClick={row => { setCreated(row); setSelectedId(row.id); }}
        empty={<EmptyState icon={CalendarDays} title={view === "drafts" ? e.emptyDrafts : u.emptyEvents} description={configure ? e.createHelp : undefined} />}
        columns={[
          { key: "title", label: u.title, primary: true, cell: row => <span>{row.title}{configure && pages.data && pageChanged(row) ? <span className="mt-1 block text-xs font-normal text-amber-700 dark:text-amber-300">{e.pageChanges}</span> : null}</span> },
          { key: "when", label: u.when, cell: row => <span>{associationDate(row.startsAt)}<span className="block text-xs text-muted-foreground">{row.timezone}</span></span> },
          { key: "where", label: u.where, hideBelowMd: true, cell: row => eventWhere(row, m.options) },
          { key: "status", label: m.status, cell: row => <span className="flex flex-wrap gap-1"><StatusPill status={row.status === "draft" ? "draft" : "published"} label={row.status === "draft" ? e.hiddenDraft : e.onWebsite} />{row.status === "cancelled" || row.status === "completed" ? <StatusPill status={row.status} /> : null}</span> },
        ]} />
    </AssociationListState>
  </section>;
}
