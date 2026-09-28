"use client";

/** Event detail: tickets, guests (check-in, downloads) and details, with publication changes in the header. [COMP:app-web/association] */
import Link from "next/link";
import { useState } from "react";
import { ChevronDown, Download, Pencil, Ticket, Users } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { checkInAssociationAttendee,correctAssociationCheckIn,exportAssociationAttendees,exportAssociationOperationalRoster,saveAssociationEvent,type AssociationEvent,type AssociationRegistration,type AssociationTicket } from "@/lib/api/association";
import { listCrmConsentPurposes } from "@/lib/api/crm";
import { crmRecordHref } from "@/lib/crm-view";
import { associationPageCacheKey } from "@/lib/surface-prefetch";
import { useCachedResource } from "@/lib/surface-cache";
import { Button, buttonVariants } from "@/components/ui/button";
import { Select,SelectTrigger,SelectContent,SelectItem,SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AssociationField,useAssociationPage,AssociationListState,useAssociationAction } from "./operator-controls";
import { AssociationTicketForm } from "./catalog-forms";
import { AssociationEditor, associationMoney } from "./workspace-ui";
import { AssociationReservationForm } from "./reservation-form";
import { associationHref } from "./navigation";
import { eventWhere } from "./events-panel";
import { EventPageEditor } from "./events/event-page-editor";
import { EmptyState, InlineNotice, PageHeader, ResponsiveTable, Segmented, StatusPill, TechnicalDetails, associationDate } from "./ui";

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

function Tickets({workspaceId,event,enabled,currencies}:{workspaceId:string;event:AssociationEvent;enabled:boolean;currencies:string[]}) {
  const t=useT().associationPage,u=t.ux,m=t.manage,rows=useAssociationPage(workspaceId,"tickets",{eventId:event.id});
  const [saved,setSaved]=useState(false),[editing,setEditing]=useState<AssociationTicket|"new"|null>(null),[reserving,setReserving]=useState<AssociationTicket|null>(null);
  const known=[...new Set([...(rows.data?.items.map(row=>row.currency) ?? []),...currencies])];
  if(editing)return <AssociationEditor title={editing==="new"?m.newTicket:editing.name} onClose={()=>setEditing(null)}><AssociationTicketForm key={editing==="new"?"new":editing.id} workspaceId={workspaceId} eventId={event.id} ticket={editing==="new"?undefined:editing} currencies={known} disabled={!enabled||!!rows.error} onSaved={()=>{setEditing(null);setSaved(true);void rows.refresh();}}/></AssociationEditor>;
  if(reserving)return <AssociationEditor title={`${u.reserveFor}: ${reserving.name}`} onClose={()=>setReserving(null)}><AssociationReservationForm key={reserving.id} workspaceId={workspaceId} ticket={rows.data?.items.find(row=>row.id===reserving.id) ?? reserving} disabled={!enabled||!!rows.error}/></AssociationEditor>;
  return <section className="space-y-4" data-event-tickets>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-lg font-semibold">{m.tickets}</h3><Button type="button" className="min-h-11 md:min-h-9" disabled={!enabled||!!rows.error} onClick={()=>{setSaved(false);setEditing("new");}}><Ticket aria-hidden className="size-4"/>{m.newTicket}</Button></div>
    {saved?<InlineNotice tone="success">{u.saved}</InlineNotice>:null}
    <AssociationListState {...rows}>
      <ResponsiveTable rows={rows.data?.items ?? []} rowKey={row=>row.id} rowData={row=>({"data-ticket-row":row.id})} empty={<EmptyState icon={Ticket} title={u.emptyTickets}/>}
        columns={[
          {key:"name",label:m.name,cell:row=><span className="font-medium">{row.name}</span>},
          {key:"price",label:m.price,cell:row=><span>{associationMoney(row.priceMinor,row.currency)}{row.memberPriceMinor!==null?<span className="block text-xs text-muted-foreground">{m.memberPrice.replace(/ \(.*\)$/,"")}: {associationMoney(row.memberPriceMinor,row.currency)}</span>:null}</span>},
          {key:"availability",label:m.available,cell:row=><span>{row.available ?? m.unlimited}<span className="block text-xs text-muted-foreground">{m.reserved}: {row.reservedCount}</span></span>},
          {key:"status",label:m.status,cell:row=><StatusPill status={row.status}/>},
        ]}
        actions={row=><><Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-8" disabled={!enabled||!!rows.error||row.status!=="on_sale"} onClick={()=>setReserving(row)}>{u.reserveFor}</Button><Button type="button" size="sm" variant="ghost" className="min-h-11 md:min-h-8" disabled={!enabled||!!rows.error} onClick={()=>setEditing(row)}>{m.edit}</Button></>}/>
    </AssociationListState>
  </section>;
}

export function AssociationEventDetail({workspaceId,event,enabled,canManage,loadFailed,onBack,onEdit,onChanged}:{workspaceId:string;event:AssociationEvent;enabled:boolean;canManage:boolean;loadFailed:boolean;onBack:()=>void;onEdit:()=>void;onChanged:()=>void}) {
  const t=useT().associationPage,u=t.ux,m=t.manage,action=useAssociationAction(workspaceId);
  // Owners/admins land on the page builder (the website side); members, who cannot edit it, on tickets.
  const [tab,setTab]=useState<"page"|"tickets"|"guests"|"details">(canManage?"page":"tickets");
  const plans=useAssociationPage(workspaceId,"plans");
  // Without a ticket the website shows registration as closed; say so where staff can fix it.
  const tickets=useAssociationPage(workspaceId,"tickets",{eventId:event.id});
  const noTickets=canManage&&tickets.data?.items.length===0&&(event.status==="draft"||event.status==="published")&&Date.parse(event.endsAt)>=Date.now();
  const currencies=[...new Set((plans.data?.items ?? []).map(plan=>plan.currency))];
  const changeStatus=(status:AssociationEvent["status"],review:{description:string;destructive?:boolean}|false)=>void action.run(status==="published"?u.publish:status==="completed"?u.markCompleted:u.cancelEvent,async()=>{const {id:_id,...body}=event;await saveAssociationEvent(workspaceId,{...body,status});onChanged();},review);
  const transitions=[...(event.status==="draft"?[{status:"published" as const,label:u.publish}]:[]),...(event.status==="published"?[{status:"completed" as const,label:u.markCompleted}]:[]),...(event.status!=="cancelled"&&event.status!=="completed"?[{status:"cancelled" as const,label:u.cancelEvent}]:[])];
  return <section className="space-y-6" data-event-detail>
    <PageHeader back={{label:u.backEvents,onClick:onBack}} title={event.title} description={`${associationDate(event.startsAt)} · ${associationDate(event.endsAt)} · ${eventWhere(event,m.options)}`}
      actions={<><StatusPill status={event.status} className="self-center"/>
        {canManage?<Button type="button" variant="outline" className="min-h-11 md:min-h-9" disabled={loadFailed} onClick={onEdit}><Pencil aria-hidden className="size-4"/>{m.edit}</Button>:null}
        {canManage&&transitions.length?<DropdownMenu><DropdownMenuTrigger disabled={loadFailed||action.pending} className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm hover:bg-accent disabled:opacity-50 md:min-h-9">{u.changeStatus}<ChevronDown aria-hidden className="size-4 text-muted-foreground"/></DropdownMenuTrigger>
          <DropdownMenuContent align="end">{transitions.map(item=><DropdownMenuItem key={item.status} className="min-h-11 sm:min-h-0" variant={item.status==="cancelled"?"destructive":"default"} onClick={()=>changeStatus(item.status,item.status==="cancelled"?{description:u.cancelEventConfirm,destructive:true}:false)}>{item.label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>:null}
        <Link href={associationHref(workspaceId,"orders",{eventId:event.id})} className={buttonVariants({variant:"ghost",className:"min-h-11 md:min-h-9"})}>{t.eventOrders}</Link></>}>
      <Segmented label={u.goTo} value={tab} onChange={setTab} options={[...(canManage?[{value:"page" as const,label:t.eventPage.pageTab}]:[]),{value:"tickets" as const,label:m.tickets},{value:"guests" as const,label:u.guests},{value:"details" as const,label:u.detailsTab}]}/>
    </PageHeader>
    {action.feedback}
    {noTickets?<InlineNotice tone="warning" title={u.noTicketsTitle} action={tab!=="tickets"?<Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-8" onClick={()=>setTab("tickets")}>{m.newTicket}</Button>:undefined}>{u.noTicketsBody}</InlineNotice>:null}
    {tab==="page"&&canManage?<EventPageEditor workspaceId={workspaceId} event={event}/>:null}
    {tab==="tickets"?<Tickets workspaceId={workspaceId} event={event} enabled={enabled} currencies={currencies}/>:null}
    {tab==="guests"?<Guests workspaceId={workspaceId} eventId={event.id} canManage={canManage}/>:null}
    {tab==="details"?<section className="space-y-4 rounded-2xl border border-border bg-background p-5" data-event-details>
      {event.description?<p className="text-sm whitespace-pre-wrap">{event.description}</p>:null}
      <dl className="grid gap-3 text-sm md:grid-cols-2">
        <div><dt className="text-xs text-muted-foreground">{u.where}</dt><dd>{eventWhere(event,m.options)}{event.onlineUrl?<a className="block break-all text-primary" href={event.onlineUrl} target="_blank" rel="noreferrer">{event.onlineUrl}</a>:null}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{m.timezone}</dt><dd>{event.timezone}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{m.opens}</dt><dd>{event.registrationOpensAt?associationDate(event.registrationOpensAt):m.unlimited}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{m.closes}</dt><dd>{event.registrationClosesAt?associationDate(event.registrationClosesAt):m.unlimited}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{u.capacity}</dt><dd>{event.capacity ?? m.unlimited}</dd></div>
        {event.canonicalUrl?<div><dt className="text-xs text-muted-foreground">{m.canonicalUrl}</dt><dd><a className="break-all text-primary" href={event.canonicalUrl} target="_blank" rel="noreferrer">{event.canonicalUrl}</a></dd></div>:null}
      </dl>
      <TechnicalDetails rows={[[u.reference,event.slug],...(event.programmeKey?[[m.programmeKey,event.programmeKey] as [string,string]]:[]),[m.eventId,event.id]]}/>
    </section>:null}
  </section>;
}
