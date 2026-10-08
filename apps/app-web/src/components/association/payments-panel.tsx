"use client";

/** Offline payments: owner/admin table of cases and the record / mark-paid / undo / cancel flows. [COMP:app-web/association] */
import Link from "next/link";
import { useEffect, useState } from "react";
import { Banknote } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import type { AssociationPlan } from "@/lib/api/association";
import { crmRecordHref } from "@/lib/crm-view";
import { Button } from "@/components/ui/button";
import { useAssociationModule } from "./module-controls";
import { AssociationContactPicker, AssociationListState, useAssociationContactSelection, useAssociationPage } from "./operator-controls";
import { AssociationMembershipRescueActionForm, AssociationMembershipRescueForm, type AssociationRescueIntent } from "./membership-rescue";
import { AssociationEditor, associationMoney } from "./workspace-ui";
import { EmptyState, InlineNotice, PageHeader, ResponsiveTable, StatusPill, associationDate } from "./ui";

export function AssociationPaymentsPanel({workspaceId,initialNew=false}:{workspaceId:string;initialNew?:boolean}) {
  const t=useT().associationPage,u=t.ux,m=t.manage,module=useAssociationModule(workspaceId);
  const canManage=!!module.data?.canManage&&!module.error;
  const rescues=useAssociationPage(workspaceId,"rescues",{},canManage),plans=useAssociationPage(workspaceId,"plans",{},canManage);
  const [mode,setMode]=useState<"list"|"new">(initialNew?"new":"list"),[contact,setContact]=useAssociationContactSelection(workspaceId),[plan,setPlan]=useState<AssociationPlan|null>(null);
  const [selected,setSelected]=useState<{id:string;intent:AssociationRescueIntent}|null>(null),[saved,setSaved]=useState(false);
  const selectedRow=canManage?rescues.data?.items.find(row=>row.id===selected?.id):undefined;
  useEffect(()=>{if(selected&&!selectedRow)setSelected(null);},[selected,selectedRow]);
  function done(){setSelected(null);setMode("list");setPlan(null);setSaved(true);void rescues.refresh();}
  if(module.data&&!module.data.canManage)return <section className="space-y-5"><PageHeader title={u.offlinePayments} description={u.offlinePaymentsHelp}/><InlineNotice tone="neutral">{t.ownerOnly}</InlineNotice></section>;
  if(selected&&selectedRow)return <AssociationEditor title={selected.intent==="settle"?u.markPaid:selected.intent==="cancel"?u.cancelCase:u.undoPayment} onClose={()=>setSelected(null)}><AssociationMembershipRescueActionForm key={`${selected.id}:${selected.intent}`} workspaceId={workspaceId} row={selectedRow} intent={selected.intent} onSaved={done}/></AssociationEditor>;
  if(!canManage)return <section className="space-y-5"><PageHeader title={u.offlinePayments} description={u.offlinePaymentsHelp}/><AssociationListState {...module}>{null}</AssociationListState></section>;
  if(mode==="new")return <AssociationEditor title={u.recordOfflinePayment} onClose={()=>{setMode("list");setPlan(null);}}>
    <div className="space-y-5">
      <section className="space-y-2"><h3 className="text-sm font-semibold">{u.selectPerson}</h3><AssociationContactPicker workspaceId={workspaceId} selected={contact} onSelect={row=>{setContact(row);setPlan(null);}} onClear={()=>{setContact(null);setPlan(null);}}/></section>
      {contact&&!plan?<section className="space-y-2"><h3 className="text-sm font-semibold">{u.choosePlan}</h3><AssociationListState {...plans}><div className="grid gap-3 md:grid-cols-2">{plans.data?.items.filter(row=>!row.provider&&Number(row.feeMinor)>0).map(row=><button key={row.id} type="button" className="flex min-h-8 max-sm:min-h-11 flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4 text-left hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring" disabled={!!plans.error} onClick={()=>setPlan(row)}><span className="font-medium">{row.name}</span><span className="text-sm text-muted-foreground">{associationMoney(row.feeMinor,row.currency)}</span></button>)}</div></AssociationListState></section>:null}
      {contact&&plan?<AssociationMembershipRescueForm key={`${plan.id}:${contact.id}`} workspaceId={workspaceId} plan={plan} contact={contact} disabled={!canManage||!!plans.error} onSaved={done}/>:null}
    </div>
  </AssociationEditor>;
  return <section className="space-y-5">
    <PageHeader title={u.offlinePayments} description={u.offlinePaymentsHelp} actions={<Button type="button" className="min-h-11 md:min-h-9" disabled={!canManage} onClick={()=>{setSaved(false);setMode("new");}}><Banknote aria-hidden className="size-4"/>{u.recordOfflinePayment}</Button>}/>
    {saved?<InlineNotice tone="success">{u.saved}</InlineNotice>:null}
    <p className="text-xs text-muted-foreground">{m.offlineRescuesHelp}</p>
    <AssociationListState {...rescues}>
      <ResponsiveTable rows={rescues.data?.items ?? []} rowKey={row=>row.id} rowData={row=>({"data-payment-row":row.id})} empty={<EmptyState icon={Banknote} title={u.emptyPayments}/>}
        columns={[
          {key:"person",label:u.person,primary:true,cell:row=><Link className="inline-flex min-h-11 items-center font-medium text-primary md:min-h-0" href={crmRecordHref(workspaceId,"contact",row.contactId)}>{row.contactName}</Link>},
          {key:"plan",label:u.plan,cell:row=>row.planName},
          {key:"amount",label:u.amount,align:"end",cell:row=>associationMoney(row.amountMinor,row.currency)},
          {key:"due",label:u.due,cell:row=><span className={row.overdue?"font-medium text-destructive":""}>{associationDate(row.dueAt,"date")}{row.overdue?` · ${m.overdue}`:""}</span>},
          {key:"status",label:m.status,cell:row=><StatusPill status={row.status}/>},
          {key:"period",label:u.starts,hideBelowMd:true,cell:row=>`${associationDate(row.startsAt,"date")} / ${associationDate(row.endsAt,"date")}`},
        ]}
        actions={row=>row.status==="outstanding"?<><Button type="button" size="sm" className="min-h-11 md:min-h-8" disabled={!!rescues.error} onClick={()=>setSelected({id:row.id,intent:"settle"})}>{u.markPaid}</Button><Button type="button" size="sm" variant="ghost" className="min-h-11 md:min-h-8" disabled={!!rescues.error} onClick={()=>setSelected({id:row.id,intent:"cancel"})}>{u.cancelCase}</Button></>
          :row.status==="settled"?<Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-8" disabled={!!rescues.error} onClick={()=>setSelected({id:row.id,intent:"reverse"})}>{u.undoPayment}</Button>:null}/>
    </AssociationListState>
  </section>;
}
