"use client";

/** Events index: table with upcoming/past/draft views, opening the event detail page. [COMP:app-web/association] */
import { useState } from "react";
import { CalendarDays, Plus } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import type { AssociationEvent } from "@/lib/api/association";
import { Button } from "@/components/ui/button";
import { useAssociationModule } from "./module-controls";
import { ReadOnlyNotice } from "./access";
import { AssociationListState,useAssociationPage } from "./operator-controls";
import { AssociationEventForm } from "./catalog-forms";
import { AssociationEditor } from "./workspace-ui";
import { AssociationEventDetail } from "./event-detail";
import { EmptyState, InlineNotice, PageHeader, ResponsiveTable, Segmented, StatusPill, associationDate } from "./ui";

type EventView="upcoming"|"past"|"drafts"|"all";
export function eventWhere(event:AssociationEvent,labels:{venue:string;online:string;hybrid:string}):string {
  if(event.mode==="online")return event.onlineUrl?labels.online:labels.online;
  return event.venue||labels[event.mode];
}

export function AssociationEventsPanel({workspaceId,initialEventId="",initialNew=false}:{workspaceId:string;initialEventId?:string;initialNew?:boolean}) {
  const [view,setView]=useState<EventView>("upcoming");
  // Each view asks the server for its own rows; pages are oldest-first, so filtering one page client-side hides newer events.
  const t=useT().associationPage,u=t.ux,m=t.manage,rows=useAssociationPage(workspaceId,"events",view==="upcoming"?{when:"upcoming"}:view==="past"?{when:"past"}:view==="drafts"?{status:"draft"}:{}),module=useAssociationModule(workspaceId);
  const [selectedId,setSelectedId]=useState<string|null>(initialEventId||null),[editing,setEditing]=useState<AssociationEvent|"new"|null>(initialNew?"new":null),[saved,setSaved]=useState(false);
  const configure=!!module.data?.canManage&&!module.error,enabled=module.data?.module.state==="enabled"&&!module.error;
  // A deep link reads its event directly: it may be on any page of any view.
  const direct=useAssociationPage(workspaceId,"events",{id:initialEventId},!!initialEventId);
  const selected=selectedId?rows.data?.items.find(row=>row.id===selectedId) ?? direct.data?.items.find(row=>row.id===selectedId) ?? null:null;
  const now=Date.now();
  const visible=(rows.data?.items ?? []).filter(event=>view==="all"?true:view==="drafts"?event.status==="draft":view==="past"?Date.parse(event.endsAt)<now||event.status==="completed"||event.status==="cancelled":Date.parse(event.endsAt)>=now&&event.status!=="cancelled"&&event.status!=="completed");
  if(editing)return <AssociationEditor title={editing==="new"?m.newEvent:editing.title} onClose={()=>setEditing(null)}><AssociationEventForm key={editing==="new"?"new":editing.id} workspaceId={workspaceId} event={editing==="new"?undefined:editing} disabled={!configure||!!rows.error} onSaved={()=>{setEditing(null);setSaved(true);void rows.refresh();}}/></AssociationEditor>;
  if(selectedId&&((!rows.data&&!rows.error)||(selectedId===initialEventId&&!direct.data&&!direct.error)))return <AssociationListState {...rows}><span/></AssociationListState>;
  if(selected)return <AssociationEventDetail key={selected.id} workspaceId={workspaceId} event={selected} enabled={enabled} canManage={configure} loadFailed={!!rows.error}
    onBack={()=>setSelectedId(null)} onEdit={()=>setEditing(selected)} onChanged={()=>void rows.refresh()}/>;
  return <section className="space-y-5">
    <PageHeader title={u.eventsNav} description={u.eventsHelp} actions={configure?<Button type="button" className="min-h-11 md:min-h-9" disabled={!!rows.error} onClick={()=>{setSaved(false);setEditing("new");}}><Plus aria-hidden className="size-4"/>{m.newEvent}</Button>:undefined}>
      <Segmented label={u.filters} value={view} onChange={setView} options={[{value:"upcoming",label:u.upcoming},{value:"past",label:u.past},{value:"drafts",label:u.drafts},{value:"all",label:u.all}]}/>
    </PageHeader>
    {saved?<InlineNotice tone="success">{u.saved}</InlineNotice>:null}
    {module.data&&!configure?<ReadOnlyNotice/>:null}
    {module.data&&module.data.module.state!=="enabled"?<InlineNotice tone="warning">{t.stateDescriptions[module.data.module.state]}</InlineNotice>:null}
    <AssociationListState {...rows}>
      <ResponsiveTable rows={visible} rowKey={row=>row.id} rowData={row=>({"data-event-row":row.id})} onRowClick={row=>setSelectedId(row.id)}
        empty={<EmptyState icon={CalendarDays} title={rows.data?.items.length?u.noMatches:u.emptyEvents}/>}
        columns={[
          {key:"title",label:u.title,primary:true,cell:row=>row.title},
          {key:"when",label:u.when,cell:row=><span>{associationDate(row.startsAt)}<span className="block text-xs text-muted-foreground">{row.timezone}</span></span>},
          {key:"where",label:u.where,hideBelowMd:true,cell:row=>eventWhere(row,m.options)},
          {key:"status",label:m.status,cell:row=><StatusPill status={row.status}/>},
        ]}
        actions={row=><><Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-8" onClick={()=>setSelectedId(row.id)}>{u.eventWorkspace}</Button>{configure?<Button type="button" size="sm" variant="ghost" className="min-h-11 md:min-h-8" disabled={!!rows.error} onClick={()=>setEditing(row)}>{m.edit}</Button>:null}</>}/>
    </AssociationListState>
  </section>;
}
