"use client";

/** Sponsor allocation, nomination and revocation controls. [COMP:app-web/association] */
import {useEffect,useMemo,useState} from "react";
import {useT} from "@/lib/i18n/client";
import {Button} from "@/components/ui/button";
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from "@/components/ui/select";
import {
  cancelAssociationSponsorshipAllocation,createAssociationSponsorshipAllocation,
  issueAssociationSponsorshipInvitation,revokeAssociationSponsorshipInvitation,
} from "@/lib/api/association";
import {
  AssociationContactPicker,AssociationField,AssociationIntentNotice,AssociationListState,
  associationInstant,associationLocalTime,useAssociationContactSelection,useAssociationAction,useAssociationIntent,useAssociationPage,
} from "./operator-controls";
import {StatusPill} from "./ui";
import {useAssociationModule} from "./module-controls";

const selectClass="max-sm:min-h-11 w-full rounded-lg border border-border bg-background px-3 py-2 text-base";
const plusYear=()=>{const date=new Date();date.setUTCFullYear(date.getUTCFullYear()+1);return date.toISOString();};

function AssociationSponsorships({workspaceId,canManage}:{workspaceId:string;canManage:boolean}){
  const copy=useT().associationPage,t=copy.sponsorship,plans=useAssociationPage(workspaceId,"plans"),action=useAssociationAction(workspaceId);
  const allocations=useAssociationPage(workspaceId,"allocations"),invitations=useAssociationPage(workspaceId,"invitations");
  const [sponsor,setSponsor]=useAssociationContactSelection(workspaceId),[nominee,setNominee]=useAssociationContactSelection(workspaceId);
  const sponsorMemberships=useAssociationPage(workspaceId,"memberships",sponsor?{contactId:sponsor.id,activeOnly:true}:{},!!sponsor);
  const [sponsorMembershipId,setSponsorMembershipId]=useState(""),[beneficiaryPlanId,setBeneficiaryPlanId]=useState("");
  const [seatLimit,setSeatLimit]=useState("1"),[ttl,setTtl]=useState("168");
  const [startsAt,setStartsAt]=useState(associationLocalTime(new Date().toISOString())),[endsAt,setEndsAt]=useState(associationLocalTime(plusYear()));
  const [allocationId,setAllocationId]=useState(""),[tokenState,setToken]=useState<{id:string;value:string}|null>(null),[reason,setReason]=useState("");
  const token=tokenState&&nominee&&allocations.data?.items.some(row=>row.id===allocationId&&row.status==="active")
    &&invitations.data?.items.some(row=>row.id===tokenState.id&&row.nomineeContactId===nominee.id&&row.status==="pending"&&!row.expired)?tokenState.value:null;
  useEffect(()=>{if(tokenState&&!token)setToken(null);},[tokenState,token]);
  const allocationIntent=useAssociationIntent(workspaceId,"sponsorship-allocation",`${sponsor?.id}:${sponsorMembershipId}:${beneficiaryPlanId}`);
  const invitationIntent=useAssociationIntent(workspaceId,"sponsorship-invitation",`${allocationId}:${nominee?.id}`);
  const freePlans=useMemo(()=>plans.data?.items.filter(plan=>!plan.provider&&Number(plan.feeMinor)===0)??[],[plans.data]);
  const directMemberships=sponsorMemberships.data?.items.filter(row=>!row.sponsorshipAllocationId)??[];
  // Root `items` map each value to its readable label; without it the trigger renders the raw record id.
  const sponsorMembershipItems=directMemberships.map(row=>({value:row.id,label:`${row.planName} · ${new Date(row.startsAt).toLocaleDateString()}`}));
  const beneficiaryPlanItems=freePlans.map(plan=>({value:plan.id,label:plan.name}));
  const allocationItems=(allocations.data?.items??[]).filter(row=>row.status==="active")
    .map(row=>({value:row.id,label:`${row.sponsorContactName} · ${row.beneficiaryPlanName} · ${row.allocatedSeats ?? copy.manage.unknown}/${row.seatLimit}`}));
  // A selection whose option left the authorized list (revocation, expiry, cancellation) is dropped, never kept as a hidden id.
  useEffect(()=>{if(allocationId&&!allocationItems.some(item=>item.value===allocationId)){setAllocationId("");setToken(null);}},[allocationId,allocationItems]);
  useEffect(()=>{if(sponsorMembershipId&&!sponsorMembershipItems.some(item=>item.value===sponsorMembershipId))setSponsorMembershipId("");},[sponsorMembershipId,sponsorMembershipItems]);
  useEffect(()=>{if(beneficiaryPlanId&&!beneficiaryPlanItems.some(item=>item.value===beneficiaryPlanId))setBeneficiaryPlanId("");},[beneficiaryPlanId,beneficiaryPlanItems]);
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
    const [,current]=await Promise.all([allocations.refresh(),invitations.refresh()]);
    const value=result.invitation.redemptionToken;
    setToken(value&&current?.items.some(row=>row.id===result.invitation.id&&row.status==="pending"&&!row.expired)?{id:result.invitation.id,value}:null);
  });
  return <section className="space-y-6 rounded-xl border border-border p-4">
    <div><h2 className="text-lg font-semibold">{t.title}</h2><p className="text-sm text-muted-foreground">{t.help}</p></div>
    <div className="grid gap-6 lg:grid-cols-2">
      <form className="space-y-3" onSubmit={e=>{e.preventDefault();void submitAllocation();}}>
        <h3 className="font-semibold">{t.createAllocation}</h3><AssociationContactPicker workspaceId={workspaceId} onSelect={row=>{setSponsor(row);setSponsorMembershipId("");}}/>
        {sponsor?<p className="text-sm">{t.sponsor}: {sponsor.name}</p>:null}
        <label className="flex flex-col gap-1 text-sm">{t.sponsorMembership}<Select items={sponsorMembershipItems} value={sponsorMembershipId || null} onValueChange={value=>setSponsorMembershipId(value ?? "")} disabled={!canManage||!sponsor} required><SelectTrigger className={selectClass} aria-label={t.sponsorMembership}><SelectValue placeholder={t.choose}/></SelectTrigger><SelectContent>{sponsorMembershipItems.map(item=><SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></label>
        <label className="flex flex-col gap-1 text-sm">{t.beneficiaryPlan}<Select items={beneficiaryPlanItems} value={beneficiaryPlanId || null} onValueChange={value=>setBeneficiaryPlanId(value ?? "")} disabled={!canManage} required><SelectTrigger className={selectClass} aria-label={t.beneficiaryPlan}><SelectValue placeholder={t.choose}/></SelectTrigger><SelectContent>{beneficiaryPlanItems.map(item=><SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></label>
        <div className="grid gap-3 sm:grid-cols-2"><AssociationField label={t.seats} type="number" min="1" max="10000" value={seatLimit} onChange={setSeatLimit}/><AssociationField label={t.ttl} type="number" min="1" max="2160" value={ttl} onChange={setTtl}/><AssociationField label={t.start} type="datetime-local" value={startsAt} onChange={setStartsAt}/><AssociationField label={t.end} type="datetime-local" value={endsAt} onChange={setEndsAt}/></div>
        {action.feedback}<AssociationIntentNotice reference={allocationIntent.reference} onReset={allocationIntent.reset} disabled={action.pending}/>
        <Button type="submit" className="max-sm:min-h-11" disabled={!canManage||action.pending||!sponsor||!sponsorMembershipId||!beneficiaryPlanId}>{t.createAllocation}</Button>
      </form>
      <form className="space-y-3" onSubmit={e=>{e.preventDefault();void submitInvitation();}}>
        <h3 className="font-semibold">{t.issueInvitation}</h3>
        <label className="flex flex-col gap-1 text-sm">{t.allocation}<Select items={allocationItems} value={allocationId || null} onValueChange={value=>{setAllocationId(value ?? "");setToken(null);}} required disabled={!canManage}><SelectTrigger className={selectClass} aria-label={t.allocation}><SelectValue placeholder={t.choose}/></SelectTrigger><SelectContent>{allocationItems.map(item=><SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></label>
        <AssociationContactPicker workspaceId={workspaceId} onSelect={row=>{setNominee(row);setToken(null);}}/>{nominee?<p className="text-sm">{t.nominee}: {nominee.name}</p>:null}
        <AssociationIntentNotice reference={invitationIntent.reference} onReset={invitationIntent.reset} disabled={action.pending}/>
        <Button type="submit" className="max-sm:min-h-11" disabled={!canManage||action.pending||!allocationId||!nominee}>{t.issueInvitation}</Button>
        {token?<div className="rounded-lg bg-muted p-3 text-sm" role="status"><p>{t.tokenHelp}</p><code className="mt-2 block break-all select-all">{token}</code><Button type="button" className="mt-2 max-sm:min-h-11" variant="outline" onClick={()=>void navigator.clipboard.writeText(token)}>{t.copyToken}</Button></div>:null}
      </form>
    </div>
    <AssociationField label={t.reason} value={reason} onChange={setReason} maxLength={2000}/>
    <AssociationListState {...allocations}><div className="divide-y divide-border">{allocations.data?.items.map(row=><div key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"><div><p className="font-medium">{row.sponsorContactName} → {row.beneficiaryPlanName}</p><p className="flex flex-wrap items-center gap-2"><StatusPill status={row.status} label={t.statuses[row.status]}/><span>{row.allocatedSeats ?? copy.manage.unknown}/{row.seatLimit} · {new Date(row.endsAt).toLocaleString()}</span></p></div>{row.status==="active"?<Button type="button" variant="outline" className="max-sm:min-h-11" disabled={!canManage||action.pending||reason.trim().length===0} onClick={()=>void action.run(t.cancelAllocation,async()=>{await cancelAssociationSponsorshipAllocation(workspaceId,row.id,{requestId:crypto.randomUUID(),reason});await Promise.all([allocations.refresh(),invitations.refresh()]);}, {description:t.cancelHelp})}>{t.cancelAllocation}</Button>:null}</div>)}</div></AssociationListState>
    <AssociationListState {...invitations}><div className="divide-y divide-border">{invitations.data?.items.map(row=><div key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"><div><p className="font-medium">{row.nomineeContactName}</p><p className="flex flex-wrap items-center gap-2"><StatusPill status={row.expired&&row.status==="pending"?"expired":row.status} label={row.expired&&row.status==="pending"?copy.manage.options.expired:t.statuses[row.status]}/><span>{new Date(row.expiresAt).toLocaleString()}</span></p></div>{row.status!=="revoked"?<Button type="button" variant="outline" className="max-sm:min-h-11" disabled={!canManage||action.pending||reason.trim().length===0} onClick={()=>void action.run(t.revokeInvitation,async()=>{await revokeAssociationSponsorshipInvitation(workspaceId,row.id,{requestId:crypto.randomUUID(),reason});await Promise.all([allocations.refresh(),invitations.refresh()]);},{description:t.revokeHelp})}>{t.revokeInvitation}</Button>:null}</div>)}</div></AssociationListState>
  </section>;
}

/** Membership → Sponsored places (owner/admin section; the surface shows who manages it to members). */
export function AssociationSponsorshipsSection({workspaceId}:{workspaceId:string}){
  // The renewed module snapshot decides management, so a role lost while the page is open disables every write control.
  const module=useAssociationModule(workspaceId),canManage=!!module.data?.canManage&&!module.error;
  return <section className="space-y-5" data-association-sponsorships><AssociationSponsorships workspaceId={workspaceId} canManage={canManage}/></section>;
}
