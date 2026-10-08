"use client";

/** Event detail: tickets, guests (check-in, downloads) and details, with publication changes in the header. [COMP:app-web/association] */
import Link from "next/link";
import { useState } from "react";
import { ChevronDown, Download, Ticket, Users } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { checkInAssociationAttendee,correctAssociationCheckIn,exportAssociationAttendees,exportAssociationOperationalRoster,saveAssociationEvent,type AssociationEvent,type AssociationRegistration,type AssociationTicket } from "@/lib/api/association";
import { listCrmConsentPurposes } from "@/lib/api/crm";
import { crmRecordHref } from "@/lib/crm-view";
import { associationPageCacheKey } from "@/lib/surface-prefetch";
import { useCachedResource } from "@/lib/surface-cache";
import { Button, buttonVariants } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Select,SelectTrigger,SelectContent,SelectItem,SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AssociationField,useAssociationPage,AssociationListState,useAssociationAction } from "./operator-controls";
import { AssociationEventForm, AssociationTicketForm } from "./catalog-forms";
import { AssociationEditor, associationMoney } from "./workspace-ui";
import { ReadOnlyNotice } from "./access";
import { AssociationReservationForm } from "./reservation-form";
import { associationHref } from "./navigation";
import { eventWhere } from "./events-panel";
import { EventPageEditor } from "./events/event-page-editor";
import { EmptyState, InlineNotice, PageHeader, ResponsiveTable, Segmented, StatusPill, associationDate } from "./ui";

function downloadCsv(name:string,csv:string) {
  const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
  const anchor=document.createElement("a");anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),0);
}

function Guests({workspaceId,eventId,canManage}:{workspaceId:string;eventId:string;canManage:boolean}) {
  const t=useT().associationPage,u=t.ux,m=t.manage,rows=useAssociationPage(workspaceId,"registrations",{eventId}),action=useAssociationAction(workspaceId);
  const purposes=useCachedResource(associationPageCacheKey(workspaceId,"email-purposes"),()=>listCrmConsentPurposes(workspaceId));
  const [purpose,setPurpose]=useState(""),[chooser,setChooser]=useState(false),[busy,setBusy]=useState<"door"|"email"|null>(null),[downloadError,setDownloadError]=useState(false);
  const [undoing,setUndoing]=useState<string|null>(null),[reasons,setReasons]=useState<Record<string,string>>({});
  async function download(kind:"door"|"email") {
    if(busy||(kind==="email"&&(!purpose||purposes.error))||(kind==="door"&&!canManage))return;
    setBusy(kind);setDownloadError(false);
    try {downloadCsv(kind==="door"?`operational-roster-${eventId}.csv`:`attendees-${eventId}.csv`,kind==="door"?await exportAssociationOperationalRoster(workspaceId,eventId):await exportAssociationAttendees(workspaceId,eventId,purpose));}
    catch {setDownloadError(true);}finally {setBusy(null);}
  }
  async function undo(row:AssociationRegistration) {
    const expectedStatus=row.status==="attended"?"attended":"checked_in",reason=(reasons[row.id]??"").trim();
    if(!canManage||reason.length<5||!["checked_in","attended"].includes(row.status))return;
    const saved=await action.run(`${u.undoCheckIn}: ${row.attendeeName}`,()=>correctAssociationCheckIn(workspaceId,row.id,expectedStatus,reason),{description:`${m.correctCheckInHelp} ${m.correctionReason}: ${reason}`});
    if(saved){setReasons(current=>({...current,[row.id]:""}));setUndoing(null);void rows.refresh();}
  }
  return <section className="space-y-4" data-event-guests>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-lg font-semibold">{u.guests}</h3><Button type="button" variant="outline" className="min-h-11 md:min-h-9" aria-expanded={chooser} onClick={()=>setChooser(value=>!value)}><Download aria-hidden className="size-4"/>{u.downloadGuests}</Button></div>
    {chooser?<div className="grid gap-3 md:grid-cols-2" data-guest-downloads>
      {canManage?<div className="space-y-2 rounded-xl border border-border p-4"><p className="font-medium">{u.doorList}</p><p className="text-xs text-muted-foreground">{m.operationalRosterHelp}</p><Button type="button" size="sm" className="min-h-11 md:min-h-8" disabled={!!busy} onClick={()=>void download("door")}>{u.doorList}</Button></div>:null}
      <div className="space-y-2 rounded-xl border border-border p-4"><p className="font-medium">{u.emailList}</p><p className="text-xs text-muted-foreground">{m.exportHelp}</p>
        <label className="flex flex-col gap-1 text-sm">{m.purpose}<Select value={purpose} onValueChange={v=>setPurpose(v ?? "")} disabled={!!busy||!!purposes.error}>
          <SelectTrigger className="min-h-11 w-full text-base md:min-h-9 md:text-sm" aria-label={m.purpose}><SelectValue placeholder={m.choose}/></SelectTrigger><SelectContent>{purposes.data?.filter(p=>!p.archivedAt&&p.applicableChannels.includes("email")).map(p=><SelectItem key={p.id} value={p.purposeKey}>{p.label}</SelectItem>)}</SelectContent></Select></label>
        <Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-8" disabled={!purpose||!!busy||!!purposes.error} onClick={()=>void download("email")}>{u.emailList}</Button></div>
      {(purposes.error||downloadError)?<p role="alert" className="col-span-full text-sm text-destructive">{m.loadFailed}</p>:null}
    </div>:null}
    <AssociationListState {...rows}>
      <ResponsiveTable rows={rows.data?.items ?? []} rowKey={row=>row.id} rowData={row=>({"data-guest-row":row.id})} empty={<EmptyState icon={Users} title={u.emptyGuests}/>}
        columns={[
          {key:"name",label:m.attendeeName,cell:row=><span>{row.attendeeContactId?<Link className="inline-flex min-h-11 items-center font-medium text-primary md:min-h-0" href={crmRecordHref(workspaceId,"contact",row.attendeeContactId)}>{row.attendeeName}</Link>:<span className="font-medium">{row.attendeeName}</span>}<span className="block break-all text-xs text-muted-foreground">{row.attendeeEmail}</span></span>},
          {key:"status",label:m.status,cell:row=><StatusPill status={row.status}/>},
        ]}
        actions={row=><>
          {["confirmed","registered"].includes(row.status)?<Button type="button" size="sm" className="min-h-11 md:min-h-8" disabled={action.pending||!!rows.error} onClick={()=>void action.run(`${m.checkIn}: ${row.attendeeName}`,()=>checkInAssociationAttendee(workspaceId,row.id),false)}>{m.checkIn}</Button>:null}
          {canManage&&["checked_in","attended"].includes(row.status)?<Button type="button" size="sm" variant="ghost" className="min-h-11 md:min-h-8" aria-expanded={undoing===row.id} onClick={()=>setUndoing(current=>current===row.id?null:row.id)}>{u.undoCheckIn}</Button>:null}
          {undoing===row.id?<div className="w-full space-y-2 rounded-lg bg-muted/40 p-3"><AssociationField label={`${m.correctionReason}: ${row.attendeeName}`} help={m.correctCheckInHelp} value={reasons[row.id]??""} maxLength={500} onChange={value=>setReasons(current=>({...current,[row.id]:value}))}/><Button type="button" size="sm" variant="destructive" className="min-h-11 md:min-h-8" disabled={action.pending||!!rows.error||(reasons[row.id]??"").trim().length<5} onClick={()=>void undo(row)}>{u.undoCheckIn}</Button></div>:null}
        </>}/>
    </AssociationListState>{action.feedback}
  </section>;
}

function Tickets({workspaceId,event,enabled,currencies,canManage=true,onDirtyChange}:{workspaceId:string;event:AssociationEvent;enabled:boolean;currencies:string[];canManage?:boolean;onDirtyChange?:(dirty:boolean)=>void}) {
  const t=useT().associationPage,u=t.ux,m=t.manage,rows=useAssociationPage(workspaceId,"tickets",{eventId:event.id});
  const [saved,setSaved]=useState(false),[editing,setEditing]=useState<AssociationTicket|"new"|null>(null),[reserving,setReserving]=useState<AssociationTicket|null>(null);
  const known=[...new Set([...(rows.data?.items.map(row=>row.currency) ?? []),...currencies])];
  if(editing&&canManage)return <AssociationEditor title={editing==="new"?m.newTicket:editing.name} onClose={()=>{setEditing(null);onDirtyChange?.(false);}}><AssociationTicketForm key={editing==="new"?"new":editing.id} workspaceId={workspaceId} eventId={event.id} ticket={editing==="new"?undefined:editing} currencies={known} onDirtyChange={onDirtyChange} disabled={!enabled||!!rows.error} onSaved={()=>{onDirtyChange?.(false);setEditing(null);setSaved(true);void rows.refresh();}}/></AssociationEditor>;
  if(reserving&&canManage)return <AssociationEditor title={`${u.reserveFor}: ${reserving.name}`} onClose={()=>setReserving(null)}><AssociationReservationForm key={reserving.id} workspaceId={workspaceId} ticket={rows.data?.items.find(row=>row.id===reserving.id) ?? reserving} disabled={!enabled||!!rows.error}/></AssociationEditor>;
  return <section className="space-y-4" data-event-tickets>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-lg font-semibold">{m.tickets}</h3>{canManage?<Button type="button" className="min-h-11 md:min-h-9" disabled={!enabled||!!rows.error} onClick={()=>{setSaved(false);setEditing("new");}}><Ticket aria-hidden className="size-4"/>{m.newTicket}</Button>:null}</div>
    {!canManage?<ReadOnlyNotice/>:null}
    {saved?<InlineNotice tone="success">{u.saved}</InlineNotice>:null}
    <AssociationListState {...rows}>
      <ResponsiveTable rows={rows.data?.items ?? []} rowKey={row=>row.id} rowData={row=>({"data-ticket-row":row.id})} empty={<EmptyState icon={Ticket} title={u.emptyTickets}/>}
        columns={[
          {key:"name",label:m.name,cell:row=><span className="font-medium">{row.name}</span>},
          {key:"price",label:m.price,cell:row=><span>{associationMoney(row.priceMinor,row.currency)}{row.memberPriceMinor!==null?<span className="block text-xs text-muted-foreground">{m.memberPrice.replace(/ \(.*\)$/,"")}: {associationMoney(row.memberPriceMinor,row.currency)}</span>:null}</span>},
          {key:"availability",label:m.available,cell:row=><span>{row.available ?? m.unlimited}<span className="block text-xs text-muted-foreground">{m.reserved}: {row.reservedCount}</span></span>},
          {key:"status",label:m.status,cell:row=><StatusPill status={row.status}/>},
        ]}
        actions={canManage?row=><><Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-8" disabled={!enabled||!!rows.error||row.status!=="on_sale"} onClick={()=>setReserving(row)}>{u.reserveFor}</Button>{canManage?<Button type="button" size="sm" variant="ghost" className="min-h-11 md:min-h-8" disabled={!enabled||!!rows.error} onClick={()=>setEditing(row)}>{m.edit}</Button>:null}</>:undefined}/>
    </AssociationListState>
  </section>;
}

export function AssociationEventDetail({workspaceId,event,enabled,canManage,loadFailed,onBack,onChanged}:{workspaceId:string;event:AssociationEvent;enabled:boolean;canManage:boolean;loadFailed:boolean;onBack:()=>void;onChanged:()=>void}) {
  const t=useT().associationPage,u=t.ux,m=t.manage,e=t.eventPage,action=useAssociationAction(workspaceId);
  const [tab,setTab]=useState<"event"|"guests">("event");
  const [dirty,setDirty]=useState(false),[detailsDirty,setDetailsDirty]=useState(false),[feesDirty,setFeesDirty]=useState(false);
  const plans=useAssociationPage(workspaceId,"plans"),tickets=useAssociationPage(workspaceId,"tickets",{eventId:event.id});
  const currencies=[...new Set((plans.data?.items ?? []).map(plan=>plan.currency))];
  async function leave(next:()=>void) {
    if((dirty||detailsDirty||feesDirty)&&!await confirmDialog({title:u.cancelEdit,description:u.cancelHelp,confirmLabel:e.discard,cancelLabel:u.keepEditing}))return;
    setDirty(false);setDetailsDirty(false);setFeesDirty(false);next();
  }
  async function changeStatus(status:AssociationEvent["status"]) {
    const body={...event};
    Reflect.deleteProperty(body,"id");
    const label=status==="published"?e.publishEvent:status==="draft"?e.removeWebsite:status==="completed"?u.markCompleted:u.cancelEvent;
    return action.run(label,async()=>{await saveAssociationEvent(workspaceId,{...body,status});onChanged();},status==="cancelled"?{description:u.cancelEventConfirm,destructive:true}:false);
  }
  return <section className="space-y-5" data-event-detail>
    <PageHeader back={{label:u.backEvents,onClick:()=>void leave(onBack)}} title={event.title} description={`${associationDate(event.startsAt)} · ${eventWhere(event,m.options)}`}
      actions={<><StatusPill status={event.status} label={event.status==="draft"?e.hiddenDraft:undefined}/>
        {canManage?<DropdownMenu><DropdownMenuTrigger disabled={loadFailed||action.pending} className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm hover:bg-accent disabled:opacity-50 md:min-h-9">{e.moreActions}<ChevronDown aria-hidden className="size-4"/></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {event.status!=="draft"?<DropdownMenuItem className="min-h-11 sm:min-h-0" onClick={()=>void changeStatus("draft")}>{e.removeWebsite}</DropdownMenuItem>:null}
            {event.status==="published"?<DropdownMenuItem className="min-h-11 sm:min-h-0" onClick={()=>void changeStatus("completed")}>{u.markCompleted}</DropdownMenuItem>:null}
            {event.status!=="cancelled"&&event.status!=="completed"?<DropdownMenuItem className="min-h-11 sm:min-h-0" variant="destructive" onClick={()=>void changeStatus("cancelled")}>{u.cancelEvent}</DropdownMenuItem>:null}
            <DropdownMenuItem className="min-h-11 sm:min-h-0" render={<Link href={associationHref(workspaceId,"orders",{eventId:event.id})}/>}>{t.eventOrders}</DropdownMenuItem>
          </DropdownMenuContent></DropdownMenu>:<Link href={associationHref(workspaceId,"orders",{eventId:event.id})} className={buttonVariants({variant:"ghost",className:"max-sm:min-h-11"})}>{t.eventOrders}</Link>}</>}>
      <Segmented label={u.goTo} value={tab} onChange={next=>void leave(()=>setTab(next))} options={[{value:"event" as const,label:canManage?e.editEvent:m.tickets},{value:"guests" as const,label:u.guests}]}/>
    </PageHeader>
    {action.feedback}
    {detailsDirty||feesDirty?<InlineNotice tone="warning">{e.finishDetails}</InlineNotice>:null}
    {tab==="event"&&canManage?<EventPageEditor workspaceId={workspaceId} event={event} tickets={tickets.data?.items} onDirtyChange={setDirty} disabled={loadFailed||action.pending||detailsDirty||feesDirty} canPublishEvent={enabled} onPublishEvent={()=>changeStatus("published")} details={<>
      <details className="rounded-2xl border border-border bg-background" data-event-basics>
        <summary className="min-h-8 max-sm:min-h-11 cursor-pointer rounded-2xl p-4 font-semibold focus-visible:outline-2 focus-visible:outline-ring">{e.nameDetails}<span className="mt-1 block text-sm font-normal text-muted-foreground">{event.title} · {eventWhere(event,m.options)}</span></summary>
        <div className="space-y-3 border-t border-border p-4"><InlineNotice tone="neutral">{event.status==="draft"?e.detailsDraftHelp:e.detailsLiveHelp}</InlineNotice>
          <AssociationEventForm key={`${event.id}:${event.title}:${event.startsAt}:${event.endsAt}`} workspaceId={workspaceId} event={event} disabled={loadFailed} onDirtyChange={setDetailsDirty} onSaved={()=>{setDetailsDirty(false);onChanged();}}/></div>
      </details>
      <details className="rounded-2xl border border-border bg-background" data-event-fees>
        <summary className="min-h-8 max-sm:min-h-11 cursor-pointer rounded-2xl p-4 font-semibold focus-visible:outline-2 focus-visible:outline-ring">{e.feesTitle}<span className="mt-1 block text-sm font-normal text-muted-foreground">{tickets.data?.items.length?tickets.data.items.map(ticket=>`${ticket.name}: ${associationMoney(ticket.priceMinor,ticket.currency)}`).join(" · "):u.emptyTickets}</span></summary>
        <div className="space-y-3 border-t border-border p-4"><InlineNotice tone="neutral">{e.feesHelp}</InlineNotice><Tickets workspaceId={workspaceId} event={event} enabled={enabled&&!loadFailed} currencies={currencies} onDirtyChange={setFeesDirty}/></div>
      </details>
    </>}/>:null}
    {tab==="event"&&!canManage?<Tickets workspaceId={workspaceId} event={event} enabled={enabled} canManage={false} currencies={currencies}/>:null}
    {tab==="guests"?<Guests workspaceId={workspaceId} eventId={event.id} canManage={canManage}/>:null}
  </section>;
}
