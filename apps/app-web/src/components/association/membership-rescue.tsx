"use client";

/** Owner/admin reviewed offline payments: record, mark as paid, undo, cancel. [COMP:app-web/association] */
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import {
  cancelAssociationMembershipRescue, createAssociationMembershipRescue,
  reverseAssociationMembershipRescue, settleAssociationMembershipRescue,
  type AssociationMembershipRescue, type AssociationPlan,
} from "@/lib/api/association";
import type { CrmLookupRow } from "@/lib/api/crm";
import { Button } from "@/components/ui/button";
import { AssociationField as Field, AssociationIntentNotice, associationInstant, useAssociationAction, useAssociationIntent } from "./operator-controls";
import { associationMoney } from "./workspace-ui";
import { ChoiceCards, FormFooter, InlineNotice } from "./ui";

export function AssociationMembershipRescueForm({workspaceId,plan,contact,disabled,onSaved}:{workspaceId:string;plan:Pick<AssociationPlan,"id"|"name"|"currency"|"feeMinor"|"provider"|"providerPlanId">;contact:CrmLookupRow;disabled:boolean;onSaved:()=>void}) {
  const t=useT().associationPage.manage,u=useT().associationPage.ux,action=useAssociationAction(workspaceId);
  const intent=useAssociationIntent(workspaceId,"membership-offline-rescue",`${plan.id}:${contact.id}`);
  const [start,setStart]=useState(""),[end,setEnd]=useState(""),[due,setDue]=useState(""),[reason,setReason]=useState("");
  const unavailable=disabled||Number(plan.feeMinor)<=0||!!plan.provider;
  return <form className="space-y-4" onSubmit={e=>{e.preventDefault();if(unavailable)return;void action.run(u.recordOfflinePayment,async()=>{
    await createAssociationMembershipRescue(workspaceId,{contactId:contact.id,planId:plan.id,idempotencyKey:intent.identity(),startsAt:associationInstant(start)!,endsAt:associationInstant(end)!,dueAt:associationInstant(due)!,reason});
    onSaved();
  },{description:`${t.rescueReview}: ${contact.name} · ${plan.name} · ${plan.currency} ${plan.feeMinor} · ${new Date(associationInstant(start)!).toLocaleString()} / ${new Date(associationInstant(end)!).toLocaleString()}`});}}>
    <p className="text-sm text-muted-foreground">{contact.name} · {plan.name}</p>
    <InlineNotice tone="neutral"><span className="font-medium">{u.amount}: {associationMoney(plan.feeMinor,plan.currency)}</span><span className="block text-xs text-muted-foreground">{t.rescueHelp}</span></InlineNotice>
    {plan.provider?<InlineNotice tone="warning">{u.providerManagedHint}</InlineNotice>:null}
    <fieldset disabled={unavailable||action.pending} className="grid gap-4 md:grid-cols-2">
      <Field label={u.membershipFrom} type="datetime-local" value={start} onChange={setStart} required help={t.timeHint}/>
      <Field label={u.membershipTo} type="datetime-local" value={end} onChange={setEnd} required/>
      <Field label={t.paymentDue} type="datetime-local" value={due} onChange={setDue} required/>
      <Field label={u.reason} value={reason} onChange={setReason} required maxLength={2000}/>
    </fieldset>
    {action.feedback}<AssociationIntentNotice reference={intent.reference} onReset={intent.reset} disabled={action.pending}/>
    <FormFooter><Button type="submit" className="min-h-11 md:min-h-9" disabled={unavailable||action.pending}>{u.recordOfflinePayment}</Button></FormFooter>
  </form>;
}

export type AssociationRescueIntent="settle"|"cancel"|"reverse";
export function AssociationMembershipRescueActionForm({workspaceId,row,onSaved,intent:requested}:{workspaceId:string;row:AssociationMembershipRescue;onSaved:()=>void;intent?:AssociationRescueIntent}) {
  const t=useT().associationPage.manage,u=useT().associationPage.ux;
  const intent:AssociationRescueIntent=requested ?? (row.status==="settled"?"reverse":"settle");
  const action=useAssociationAction(workspaceId);
  const settleIntent=useAssociationIntent(workspaceId,"membership-offline-settle",row.id);
  const reverseIntent=useAssociationIntent(workspaceId,"membership-offline-reverse",row.id);
  const cancelIntent=useAssociationIntent(workspaceId,"membership-offline-cancel",row.id);
  const [method,setMethod]=useState<"bank_transfer"|"cash"|"cheque"|"other">("bank_transfer");
  const [reference,setReference]=useState(""),[occurred,setOccurred]=useState(""),[note,setNote]=useState(""),[reason,setReason]=useState("");
  const amount=Number(row.amountMinor),pending=action.pending,money=associationMoney(row.amountMinor,row.currency);
  const summary=<p className="text-sm text-muted-foreground">{row.contactName} · {row.planName} · {money}</p>;
  if(intent==="settle"&&row.status==="outstanding")return <div className="space-y-4">{summary}
    <fieldset disabled={pending} className="grid gap-4 md:grid-cols-2">
      <ChoiceCards label={u.method} value={method} onChange={setMethod} columns={4} options={(["bank_transfer","cash","cheque","other"] as const).map(value=>({value,label:t.options[value]}))}/>
      <Field label={u.receiptNumber} value={reference} onChange={setReference} required maxLength={500}/>
      <Field label={u.paidOn} type="datetime-local" value={occurred} onChange={setOccurred} required help={t.timeHint}/>
      <div className="col-span-full"><Field label={u.noteOptional} value={note} onChange={setNote} maxLength={2000}/></div>
    </fieldset>
    <InlineNotice tone="neutral">{t.settlementExact}: {money}</InlineNotice>
    {action.feedback}<AssociationIntentNotice reference={settleIntent.reference} onReset={settleIntent.reset} disabled={pending}/>
    <FormFooter><Button type="button" className="min-h-11 md:min-h-9" disabled={pending||!reference||!occurred} onClick={()=>void action.run(u.markPaid,async()=>{
      await settleAssociationMembershipRescue(workspaceId,row.id,{requestId:settleIntent.identity(),method,evidenceReference:reference,amountMinor:amount,currency:row.currency,occurredAt:associationInstant(occurred)!,note:note||null});onSaved();
    },{description:`${t.settlementReview}: ${row.contactName} · ${row.planName} · ${row.currency} ${row.amountMinor} · ${reference}`})}>{u.markPaid}</Button></FormFooter>
  </div>;
  if(intent==="cancel"&&row.status==="outstanding")return <div className="space-y-4">{summary}
    <fieldset disabled={pending}><Field label={u.reason} value={reason} onChange={setReason} required maxLength={2000}/></fieldset>
    {action.feedback}<AssociationIntentNotice reference={cancelIntent.reference} onReset={cancelIntent.reset} disabled={pending}/>
    <FormFooter><Button type="button" className="min-h-11 md:min-h-9" variant="destructive" disabled={pending||!reason} onClick={()=>void action.run(u.cancelCase,async()=>{
      await cancelAssociationMembershipRescue(workspaceId,row.id,{requestId:cancelIntent.identity(),reason});onSaved();
    },{description:`${t.cancelRescueReview}: ${row.contactName} · ${row.planName} · ${reason}`,destructive:true})}>{u.cancelCase}</Button></FormFooter>
  </div>;
  if(intent==="reverse"&&row.status==="settled")return <div className="space-y-4">{summary}
    <p className="text-sm text-muted-foreground">{t.reversalHelp}</p>
    <fieldset disabled={pending} className="grid gap-4 md:grid-cols-2">
      <Field label={u.receiptNumber} value={reference} onChange={setReference} required maxLength={500}/>
      <Field label={t.reversalOccurred} type="datetime-local" value={occurred} onChange={setOccurred} required help={t.timeHint}/>
      <div className="col-span-full"><Field label={u.reason} value={reason} onChange={setReason} required maxLength={2000}/></div>
    </fieldset>
    {action.feedback}<AssociationIntentNotice reference={reverseIntent.reference} onReset={reverseIntent.reset} disabled={pending}/>
    <FormFooter><Button type="button" className="min-h-11 md:min-h-9" variant="destructive" disabled={pending||!reference||!occurred||!reason} onClick={()=>void action.run(u.undoPayment,async()=>{
      await reverseAssociationMembershipRescue(workspaceId,row.id,{requestId:reverseIntent.identity(),evidenceReference:reference,amountMinor:amount,currency:row.currency,occurredAt:associationInstant(occurred)!,reason});onSaved();
    },{description:`${t.reversalReview}: ${row.contactName} · ${row.planName} · ${row.currency} ${row.amountMinor} · ${reference}`,destructive:true})}>{u.undoPayment}</Button></FormFooter>
  </div>;
  return null;
}
