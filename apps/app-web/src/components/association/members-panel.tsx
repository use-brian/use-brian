"use client";

/** Members: table of memberships, add-member flow and manual date/status edits. [COMP:app-web/association] */
import Link from "next/link";
import { useEffect, useState } from "react";
import { UserPlus, Users } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { grantCrmEntitlement,updateCrmEntitlement,type CrmLookupRow } from "@/lib/api/crm";
import type { AssociationPlan,AssociationMembership } from "@/lib/api/association";
import { crmRecordHref } from "@/lib/crm-view";
import { Button, buttonVariants } from "@/components/ui/button";
import { useAssociationModule } from "./module-controls";
import { AssociationField as Field,AssociationToggle,AssociationContactPicker,AssociationIntentNotice,AssociationListState,useAssociationPage,useAssociationContactSelection,useAssociationAction,useAssociationIntent,associationLocalTime,associationInstant } from "./operator-controls";
import { AssociationEditor, associationMoney } from "./workspace-ui";
import { associationHref } from "./navigation";
import { EmptyState, FormFooter, InlineNotice, PageHeader, ResponsiveTable, Segmented, StatusPill, associationDate } from "./ui";

export function AssociationMembershipForm({workspaceId,plan,contact,row,disabled,onSaved}:{workspaceId:string;plan?:AssociationPlan;contact?:CrmLookupRow;row?:AssociationMembership;disabled:boolean;onSaved:()=>void}) {
  const t=useT().associationPage.manage,u=useT().associationPage.ux,action=useAssociationAction(workspaceId);
  const intent=useAssociationIntent(workspaceId,"membership",`${plan?.id ?? row?.planId}:${contact?.id ?? row?.contactId}`);
  const [start,setStart]=useState(row?associationLocalTime(row.startsAt):associationLocalTime(new Date().toISOString())),[end,setEnd]=useState(associationLocalTime(row?.endsAt));
  const [status,setStatus]=useState<AssociationMembership["status"]>(row?.status ?? "active"),[renewal,setRenewal]=useState<AssociationMembership["renewalMode"]>(row?.renewalMode ?? "none");
  const providerManaged=!!row?.provider;
  const unavailable=disabled||providerManaged||(!row&&(!plan||!contact||!!plan.provider||Number(plan.feeMinor)!==0));
  if(providerManaged)return <InlineNotice tone="neutral" title={t.adjust}>{u.providerManagedHint}</InlineNotice>;
  return <form className="space-y-4" onSubmit={e=>{e.preventDefault();if(unavailable)return;void action.run(row?u.editMembership:u.addFree,async()=>{
    const changes={status,endsAt:associationInstant(end),renewalMode:renewal};
    if(row) await updateCrmEntitlement(workspaceId,row.id,changes);
    else await grantCrmEntitlement(workspaceId,{contactId:contact!.id,planId:plan!.id,idempotencyKey:intent.identity(),startsAt:associationInstant(start)!,...changes});
    onSaved();
  });}}>
    <p className="text-sm text-muted-foreground">{contact?.name ?? row?.contactName} · {plan?.name ?? row?.planName}</p>
    <fieldset disabled={unavailable||action.pending} className="grid gap-4 md:grid-cols-2">
      <Field label={t.start} type="datetime-local" value={start} onChange={setStart} required disabled={!!row} help={t.timeHint}/>
      <Field label={t.end} type="datetime-local" value={end} onChange={setEnd} help={u.capacityHelp}/>
      {row?<div className="space-y-1.5 text-sm"><p className="font-medium">{t.status}</p><Segmented label={t.status} value={status} onChange={setStatus} options={(["pending","active","expired","cancelled"] as const).map(value=>({value,label:t.options[value]}))}/></div>:null}
      <div className="space-y-1.5 text-sm"><p className="font-medium">{t.renewal}</p><Segmented label={t.renewal} value={renewal} onChange={setRenewal} options={(["none","manual","auto"] as const).map(value=>({value,label:t.options[value]}))}/></div>
    </fieldset>
    {!row&&plan&&Number(plan.feeMinor)!==0?<InlineNotice tone="warning">{u.paidPlanHint}</InlineNotice>:null}
    {row?<p className="text-xs text-muted-foreground">{t.renewalHelp}</p>:null}
    {action.feedback}{!row?<AssociationIntentNotice reference={intent.reference} onReset={intent.reset} disabled={action.pending}/>:null}
    <FormFooter><Button type="submit" className="min-h-11 md:min-h-9" disabled={unavailable||action.pending}>{row?t.save:u.addFree}</Button></FormFooter>
  </form>;
}

export function AssociationMembersPanel({workspaceId,initialNew=false}:{workspaceId:string;initialNew?:boolean}) {
  const t=useT().associationPage,u=t.ux,m=t.manage,plans=useAssociationPage(workspaceId,"plans"),module=useAssociationModule(workspaceId);
  const [mode,setMode]=useState<"list"|"add">(initialNew?"add":"list");
  const [contact,setContact]=useAssociationContactSelection(workspaceId),[effectiveOnly,setEffectiveOnly]=useState(false),[saved,setSaved]=useState(false);
  const [grant,setGrant]=useState<AssociationPlan|null>(null),[adjustId,setAdjustId]=useState<string|null>(null);
  const memberships=useAssociationPage(workspaceId,"memberships",{...(contact&&mode==="list"?{contactId:contact.id}:{}),activeOnly:effectiveOnly});
  const canManage=!!module.data?.canManage&&!module.error;
  const adjust=memberships.data?.items.find(row=>row.id===adjustId);
  useEffect(()=>{if(adjustId&&!adjust)setAdjustId(null);},[adjustId,adjust]);
  function done(){setGrant(null);setAdjustId(null);setMode("list");setSaved(true);void memberships.refresh();}
  if(adjust)return <AssociationEditor title={u.editMembership} onClose={()=>setAdjustId(null)}><AssociationMembershipForm key={adjust.id} workspaceId={workspaceId} row={adjust} disabled={!!memberships.error} onSaved={done}/></AssociationEditor>;
  if(mode==="add")return <AssociationEditor title={u.addMember} onClose={()=>{setMode("list");setGrant(null);}}>
    <div className="space-y-5">
      <section className="space-y-2"><h3 className="text-sm font-semibold">{u.selectPerson}</h3><AssociationContactPicker workspaceId={workspaceId} selected={contact} onSelect={row=>{setContact(row);setGrant(null);}} onClear={()=>{setContact(null);setGrant(null);}}/></section>
      {contact&&!grant?<section className="space-y-2"><h3 className="text-sm font-semibold">{u.choosePlan}</h3>
        <AssociationListState {...plans}><div className="grid gap-3 md:grid-cols-2">{plans.data?.items.filter(plan=>!plan.provider).map(plan=>{const free=Number(plan.feeMinor)===0;return <div key={plan.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4"><div><p className="font-medium">{plan.name}</p><p className="text-sm text-muted-foreground">{free?t.ux.free:associationMoney(plan.feeMinor,plan.currency)}</p></div>
          {free?<Button type="button" className="min-h-11 md:min-h-8" size="sm" variant="outline" disabled={!!plans.error} onClick={()=>setGrant(plan)}>{u.addFree}</Button>
            :canManage?<Link href={associationHref(workspaceId,"payments",{new:"1"})} className={buttonVariants({size:"sm",variant:"outline",className:"min-h-11 md:min-h-8"})}>{u.recordOfflinePayment}</Link>:<span className="text-xs text-muted-foreground">{u.paidPlanHint}</span>}</div>;})}</div></AssociationListState></section>:null}
      {contact&&grant?<section className="space-y-2"><h3 className="text-sm font-semibold">{u.addFree}</h3><AssociationMembershipForm key={`${grant.id}:${contact.id}`} workspaceId={workspaceId} plan={grant} contact={contact} disabled={!!plans.error} onSaved={done}/></section>:null}
    </div>
  </AssociationEditor>;
  return <section className="space-y-5">
    <PageHeader title={u.members} description={u.membersHelp} actions={<Button type="button" className="min-h-11 md:min-h-9" onClick={()=>{setSaved(false);setGrant(null);setMode("add");}}><UserPlus aria-hidden className="size-4"/>{u.addMember}</Button>}/>
    {saved?<InlineNotice tone="success">{u.saved}</InlineNotice>:null}
    <div className="grid gap-3 rounded-2xl border border-border bg-background p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
      <AssociationContactPicker workspaceId={workspaceId} label={u.searchPeople} selected={contact} onSelect={setContact} onClear={()=>setContact(null)}/>
      <AssociationToggle label={m.effectiveOnly} checked={effectiveOnly} onChange={setEffectiveOnly}/>
    </div>
    <AssociationListState {...memberships}>
      <ResponsiveTable rows={memberships.data?.items ?? []} rowKey={row=>row.id} rowData={row=>({"data-membership-row":row.id})}
        empty={<EmptyState icon={Users} title={u.emptyMembers}/>}
        columns={[
          {key:"person",label:u.person,primary:true,cell:row=><Link className="inline-flex min-h-11 items-center font-medium text-primary md:min-h-0" href={crmRecordHref(workspaceId,"contact",row.contactId)}>{row.contactName}</Link>},
          {key:"plan",label:u.plan,cell:row=>row.planName},
          {key:"status",label:m.status,cell:row=><StatusPill status={row.status}/>},
          {key:"access",label:u.access,cell:row=><StatusPill status="" tone={row.isEffective?"success":row.isEffective===undefined?"neutral":"warning"} label={row.isEffective===undefined?m.unknown:row.isEffective?u.accessActive:u.noAccess}/>},
          {key:"starts",label:u.starts,hideBelowMd:false,cell:row=>associationDate(row.startsAt,"date")},
          {key:"ends",label:u.ends,cell:row=>row.endsAt?associationDate(row.endsAt,"date"):m.unlimited},
        ]}
        actions={row=><Button type="button" className="min-h-11 md:min-h-8" size="sm" variant="outline" disabled={!!row.provider||!!memberships.error} title={row.provider?u.providerManagedHint:undefined} onClick={()=>{setSaved(false);setAdjustId(row.id);}}>{u.editMembership}</Button>}/>
    </AssociationListState>
  </section>;
}
