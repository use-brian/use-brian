"use client";

/** Sponsor allocation, nomination and revocation controls. [COMP:app-web/association] */
import {useMemo,useState} from "react";
import {useT} from "@/lib/i18n/client";
import {Button} from "@/components/ui/button";
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from "@/components/ui/select";
import type {CrmLookupRow} from "@/lib/api/crm";
import {
  cancelAssociationSponsorshipAllocation,createAssociationSponsorshipAllocation,
  issueAssociationSponsorshipInvitation,revokeAssociationSponsorshipInvitation,
} from "@/lib/api/association";
import {
  AssociationContactPicker,AssociationField,AssociationIntentNotice,AssociationListState,
  associationInstant,associationLocalTime,useAssociationAction,useAssociationIntent,useAssociationPage,
} from "./operator-controls";

const selectClass="min-h-11 w-full rounded-lg border border-border bg-background px-3 py-2 text-base";
const plusYear=()=>{const date=new Date();date.setUTCFullYear(date.getUTCFullYear()+1);return date.toISOString();};

function AssociationSponsorships({workspaceId,canManage}:{workspaceId:string;canManage:boolean}){
  const t=useT().associationPage.sponsorship,plans=useAssociationPage(workspaceId,"plans"),action=useAssociationAction(workspaceId);
  const allocations=useAssociationPage(workspaceId,"allocations"),invitations=useAssociationPage(workspaceId,"invitations");
  const [sponsor,setSponsor]=useState<CrmLookupRow|null>(null),[nominee,setNominee]=useState<CrmLookupRow|null>(null);
  const sponsorMemberships=useAssociationPage(workspaceId,"memberships",sponsor?{contactId:sponsor.id,activeOnly:true}:{},!!sponsor);
  const [sponsorMembershipId,setSponsorMembershipId]=useState(""),[beneficiaryPlanId,setBeneficiaryPlanId]=useState("");
  const [seatLimit,setSeatLimit]=useState("1"),[ttl,setTtl]=useState("168");
  const [startsAt,setStartsAt]=useState(associationLocalTime(new Date().toISOString())),[endsAt,setEndsAt]=useState(associationLocalTime(plusYear()));
  const [allocationId,setAllocationId]=useState(""),[token,setToken]=useState<string|null>(null),[reason,setReason]=useState("");
  const allocationIntent=useAssociationIntent(workspaceId,"sponsorship-allocation",`${sponsor?.id}:${sponsorMembershipId}:${beneficiaryPlanId}`);
  const invitationIntent=useAssociationIntent(workspaceId,"sponsorship-invitation",`${allocationId}:${nominee?.id}`);
  const freePlans=useMemo(()=>plans.data?.items.filter(plan=>!plan.provider&&Number(plan.feeMinor)===0)??[],[plans.data]);
  const directMemberships=sponsorMemberships.data?.items.filter(row=>!row.sponsorshipAllocationId)??[];
  const submitAllocation=()=>action.run(t.createAllocation,async()=>{
    const start=associationInstant(startsAt),end=associationInstant(endsAt),seats=Number(seatLimit),hours=Number(ttl);
    if(!sponsor||!sponsorMembershipId||!beneficiaryPlanId||!start||!end||!Number.isInteger(seats)||!Number.isInteger(hours))throw new Error("invalid");
    await createAssociationSponsorshipAllocation(workspaceId,{sponsorContactId:sponsor.id,sponsorMembershipId,
      beneficiaryPlanId,idempotencyKey:allocationIntent.identity(),seatLimit:seats,startsAt:start,endsAt:end,invitationTtlHours:hours});
    await allocations.refresh();
  });
  const submitInvitation=()=>action.run(t.issueInvitation,async()=>{
    if(!allocationId||!nominee)throw new Error("invalid");
    const result=await issueAssociationSponsorshipInvitation(workspaceId,{allocationId,nomineeContactId:nominee.id,idempotencyKey:invitationIntent.identity()});
    setToken(result.invitation.redemptionToken??null);await Promise.all([allocations.refresh(),invitations.refresh()]);
  });
  return <section className="space-y-6 rounded-xl border border-border p-4">
    <div><h2 className="text-lg font-semibold">{t.title}</h2><p className="text-sm text-muted-foreground">{t.help}</p></div>
    <div className="grid gap-6 lg:grid-cols-2">
      <form className="space-y-3" onSubmit={e=>{e.preventDefault();void submitAllocation();}}>
        <h3 className="font-semibold">{t.createAllocation}</h3><AssociationContactPicker workspaceId={workspaceId} onSelect={row=>{setSponsor(row);setSponsorMembershipId("");}}/>
        {sponsor?<p className="text-sm">{t.sponsor}: {sponsor.name}</p>:null}
        <label className="flex flex-col gap-1 text-sm">{t.sponsorMembership}<Select value={sponsorMembershipId || null} onValueChange={value=>setSponsorMembershipId(value ?? "")} disabled={!canManage||!sponsor} required><SelectTrigger className={selectClass} aria-label={t.sponsorMembership}><SelectValue placeholder={t.choose}/></SelectTrigger><SelectContent>{directMemberships.map(row=><SelectItem key={row.id} value={row.id}>{row.planName} · {new Date(row.startsAt).toLocaleDateString()}</SelectItem>)}</SelectContent></Select></label>
        <label className="flex flex-col gap-1 text-sm">{t.beneficiaryPlan}<Select value={beneficiaryPlanId || null} onValueChange={value=>setBeneficiaryPlanId(value ?? "")} disabled={!canManage} required><SelectTrigger className={selectClass} aria-label={t.beneficiaryPlan}><SelectValue placeholder={t.choose}/></SelectTrigger><SelectContent>{freePlans.map(plan=><SelectItem key={plan.id} value={plan.id}>{plan.name}</SelectItem>)}</SelectContent></Select></label>
        <div className="grid gap-3 sm:grid-cols-2"><AssociationField label={t.seats} type="number" min="1" max="10000" value={seatLimit} onChange={setSeatLimit}/><AssociationField label={t.ttl} type="number" min="1" max="2160" value={ttl} onChange={setTtl}/><AssociationField label={t.start} type="datetime-local" value={startsAt} onChange={setStartsAt}/><AssociationField label={t.end} type="datetime-local" value={endsAt} onChange={setEndsAt}/></div>
        {action.feedback}<AssociationIntentNotice reference={allocationIntent.reference} onReset={allocationIntent.reset} disabled={action.pending}/>
        <Button type="submit" className="min-h-11" disabled={!canManage||action.pending||!sponsor||!sponsorMembershipId||!beneficiaryPlanId}>{t.createAllocation}</Button>
      </form>
      <form className="space-y-3" onSubmit={e=>{e.preventDefault();void submitInvitation();}}>
        <h3 className="font-semibold">{t.issueInvitation}</h3>
        <label className="flex flex-col gap-1 text-sm">{t.allocation}<Select value={allocationId || null} onValueChange={value=>{setAllocationId(value ?? "");setToken(null);}} required disabled={!canManage}><SelectTrigger className={selectClass} aria-label={t.allocation}><SelectValue placeholder={t.choose}/></SelectTrigger><SelectContent>{allocations.data?.items.filter(row=>row.status==="active").map(row=><SelectItem key={row.id} value={row.id}>{row.sponsorContactName} · {row.beneficiaryPlanName} · {row.allocatedSeats}/{row.seatLimit}</SelectItem>)}</SelectContent></Select></label>
        <AssociationContactPicker workspaceId={workspaceId} onSelect={row=>{setNominee(row);setToken(null);}}/>{nominee?<p className="text-sm">{t.nominee}: {nominee.name}</p>:null}
        <AssociationIntentNotice reference={invitationIntent.reference} onReset={invitationIntent.reset} disabled={action.pending}/>
        <Button type="submit" className="min-h-11" disabled={!canManage||action.pending||!allocationId||!nominee}>{t.issueInvitation}</Button>
        {token?<div className="rounded-lg bg-muted p-3 text-sm" role="status"><p>{t.tokenHelp}</p><code className="mt-2 block break-all select-all">{token}</code><Button type="button" className="mt-2 min-h-11" variant="outline" onClick={()=>void navigator.clipboard.writeText(token)}>{t.copyToken}</Button></div>:null}
      </form>
    </div>
    <AssociationField label={t.reason} value={reason} onChange={setReason} maxLength={2000}/>
    <AssociationListState {...allocations}><div className="divide-y divide-border">{allocations.data?.items.map(row=><div key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"><div><p className="font-medium">{row.sponsorContactName} → {row.beneficiaryPlanName}</p><p>{row.allocatedSeats}/{row.seatLimit} · {row.status} · {new Date(row.endsAt).toLocaleString()}</p></div>{row.status==="active"?<Button type="button" variant="outline" className="min-h-11" disabled={!canManage||action.pending||reason.trim().length===0} onClick={()=>void action.run(t.cancelAllocation,async()=>{await cancelAssociationSponsorshipAllocation(workspaceId,row.id,{requestId:crypto.randomUUID(),reason});await Promise.all([allocations.refresh(),invitations.refresh()]);}, {description:t.cancelHelp})}>{t.cancelAllocation}</Button>:null}</div>)}</div></AssociationListState>
    <AssociationListState {...invitations}><div className="divide-y divide-border">{invitations.data?.items.map(row=><div key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"><div><p className="font-medium">{row.nomineeContactName}</p><p>{row.expired?t.expired:row.status} · {new Date(row.expiresAt).toLocaleString()}</p></div>{row.status!=="revoked"?<Button type="button" variant="outline" className="min-h-11" disabled={!canManage||action.pending||reason.trim().length===0} onClick={()=>void action.run(t.revokeInvitation,async()=>{await revokeAssociationSponsorshipInvitation(workspaceId,row.id,{requestId:crypto.randomUUID(),reason});await Promise.all([allocations.refresh(),invitations.refresh()]);},{description:t.revokeHelp})}>{t.revokeInvitation}</Button>:null}</div>)}</div></AssociationListState>
  </section>;
}

/** Membership → Sponsored places (owner/admin section; the surface shows who manages it to members). */
export function AssociationSponsorshipsSection({workspaceId}:{workspaceId:string}){
  return <section className="space-y-5" data-association-sponsorships><AssociationSponsorships workspaceId={workspaceId} canManage/></section>;
}
