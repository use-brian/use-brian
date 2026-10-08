"use client";

/** Staff reservation for a buyer and named guests, keeping a stable request identity. [COMP:app-web/association] */
import Link from "next/link";
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { getAssociationOrder,previewAssociationOrderDestinations,reserveAssociationOrder,type AssociationTicket } from "@/lib/api/association";
import { associationPageCacheKey } from "@/lib/surface-prefetch";
import { crmRecordHref } from "@/lib/crm-view";
import { Button } from "@/components/ui/button";
import { format } from "@/lib/i18n/format";
import { useAssociationProjection,AssociationContactPicker,AssociationListState,AssociationField,AssociationIntentNotice,useAssociationContactSelection,useAssociationContactSources,useAssociationAction,useAssociationIntent } from "./operator-controls";
import { associationHref } from "./navigation";
import { ChoiceCards, FormFooter, FormSection, InlineNotice, SwitchField } from "./ui";

type Attendee={key:string;name:string;email:string;contactId?:string};
export function AssociationReservationForm({workspaceId,ticket,disabled}:{workspaceId:string;ticket:AssociationTicket;disabled:boolean}) {
  const t=useT().associationPage,u=t.ux,m=t.manage,action=useAssociationAction(workspaceId);
  const intent=useAssociationIntent(workspaceId,"reserve",ticket.id);
  const unavailable=disabled&&!intent.reference;
  const [buyer,setBuyer]=useAssociationContactSelection(workspaceId),[minutes,setMinutes]=useState("20"),[member,setMember]=useState(false);
  const [attendees,setAttendees]=useState<Attendee[]>([{key:"first",name:"",email:""}]),[orderId,setOrderId]=useState<string|null>(null),[linking,setLinking]=useState<string|null>(null);
  const saved=useAssociationProjection(orderId?associationPageCacheKey(workspaceId,"reservation-result",{id:orderId}):null,()=>getAssociationOrder(workspaceId,orderId!));
  const linked=useAssociationContactSources(workspaceId,attendees.flatMap(row=>row.contactId?[row.contactId]:[]));
  const projected=attendees.map(row=>{
    if(!row.contactId)return row;
    const contact=linked.data?.find(contact=>contact.id===row.contactId);
    return contact?{...row,name:row.name||contact.name}:null;
  });
  const guestsAvailable=projected.every(row=>row!==null);
  const [destination,setDestination]=useState("default");
  const sourceIds=[...new Set([...(buyer?[buyer.id]:[]),...attendees.flatMap(row=>row.contactId?[row.contactId]:[])])].sort();
  const preview=useAssociationProjection(buyer&&guestsAvailable?associationPageCacheKey(workspaceId,"order-destinations",{ids:sourceIds}):null,
    ()=>previewAssociationOrderDestinations(workspaceId,sourceIds));
  const choiceKey=(choice:NonNullable<typeof preview.data>["choices"][number])=>choice.destination===null?"default":choice.destination.kind==="general"?"general":choice.destination.departmentId;
  const selected=preview.data?.choices.find(choice=>choiceKey(choice)===destination);

  function update(key:string,change:Partial<Attendee>) {setAttendees(rows=>rows.map(row=>row.key===key?{...row,...change}:row));}
  return <form className="space-y-5" onSubmit={e=>{e.preventDefault();if(unavailable||!buyer||!guestsAvailable||!selected)return;void action.run(u.reserveFor,async()=>{
    const result=await reserveAssociationOrder(workspaceId,{...(selected.destination?{destination:selected.destination}:{}),contactId:buyer.id,idempotencyKey:intent.identity(),reservationMinutes:Number(minutes),lines:[{ticketId:ticket.id,quantity:attendees.length,useMemberPrice:member,attendees:projected.filter(row=>row!==null).map(({name,email,contactId})=>({name,...(email?{email}:{}),...(contactId?{contactId}:{})}))}]});setOrderId(result.order.id);
  });}}>
    <fieldset disabled={unavailable||action.pending} className="grid min-w-0 gap-6">
      <FormSection title={u.buyer}>
        <div className="col-span-full"><AssociationContactPicker workspaceId={workspaceId} selected={buyer} onSelect={setBuyer} onClear={()=>setBuyer(null)}/>{!buyer?<p className="mt-1 text-xs text-muted-foreground">{m.contactRequired}</p>:null}</div>
        <div className="col-span-full"><SwitchField label={m.memberPricing} checked={member} onChange={setMember} disabled={ticket.memberPriceMinor===null}/></div>
      </FormSection>
      <FormSection title={u.guests}>
        {attendees.map((row,index)=><div key={row.key} className="col-span-full space-y-3 rounded-xl border border-border p-4" data-association-attendee>
          <div className="flex items-center justify-between gap-2"><h4 className="text-sm font-medium">{format(u.guest,{n:index+1})}</h4><Button type="button" variant="ghost" size="sm" className="min-h-11 md:min-h-8" disabled={attendees.length===1} onClick={()=>setAttendees(rows=>rows.filter(r=>r.key!==row.key))}><X aria-hidden className="size-4"/>{m.remove}</Button></div>
          {!row.contactId||projected[index]?<div className="grid gap-3 md:grid-cols-2"><AssociationField label={m.attendeeName} value={projected[index]?.name ?? ""} onChange={name=>update(row.key,{name})} required maxLength={200}/><AssociationField label={m.attendeeEmail} type="email" value={row.email} onChange={email=>update(row.key,{email})} maxLength={320}/></div>:<AssociationListState data={undefined} error={linked.error} refresh={linked.refresh} compact>{null}</AssociationListState>}
          {row.contactId?<div className="flex flex-wrap gap-2">{projected[index]?<Link className="inline-flex min-h-11 items-center text-sm text-primary md:min-h-8" href={crmRecordHref(workspaceId,"contact",row.contactId)}>{t.openContact}</Link>:null}<Button type="button" variant="ghost" size="sm" className="min-h-11 md:min-h-8" onClick={()=>update(row.key,{contactId:undefined,name:"",email:""})}>{u.clear}</Button></div>
            :linking===row.key?<AssociationContactPicker workspaceId={workspaceId} label={u.linkContact} onSelect={contact=>{update(row.key,{contactId:contact.id,name:"",email:""});setLinking(null);}}/>
            :<Button type="button" variant="ghost" size="sm" className="min-h-11 md:min-h-8" onClick={()=>setLinking(row.key)}>{u.linkContact}</Button>}
        </div>)}
        <div className="col-span-full"><Button type="button" variant="outline" className="min-h-11 md:min-h-9" disabled={attendees.length>=ticket.perOrderLimit} onClick={()=>setAttendees(rows=>[...rows,{key:crypto.randomUUID(),name:"",email:""}])}><Plus aria-hidden className="size-4"/>{m.addAttendee}</Button></div>
      </FormSection>
      {buyer&&guestsAvailable?<FormSection title={u.destinationTitle}>
        <div className="col-span-full"><p className="text-sm text-muted-foreground">{u.destinationHelp}</p>
          <AssociationListState data={preview.data} error={preview.error} refresh={preview.refresh} compact>
            {preview.data?<ChoiceCards label={u.destinationTitle} value={destination} onChange={setDestination} options={preview.data.choices.map(choice=>({value:choiceKey(choice),
              label:choice.destination===null?u.destinationDefault:choice.destination.kind==="general"?u.destinationGeneral:choice.departments.find(row=>row.id===(choice.destination?.kind==="department"?choice.destination.departmentId:null))?.name??u.destinationTitle,
              hint:choice.departments.map(row=>row.name).join(", ")||u.destinationGeneral}))}/>:null}
            {preview.data&&!selected?<InlineNotice>{u.destinationUnavailable}</InlineNotice>:null}
          </AssociationListState>
        </div>
      </FormSection>:null}
      <FormSection title={u.moreOptions} collapsible>
        <AssociationField label={u.holdFor} type="number" min={1} max={120} required value={minutes} onChange={setMinutes}/>
      </FormSection>
    </fieldset>
    {action.feedback}<AssociationIntentNotice reference={intent.reference} onReset={intent.reset} disabled={action.pending}/>
    {orderId?<AssociationListState data={saved.data} error={saved.error} refresh={saved.refresh} compact>{saved.data?.id===orderId?<InlineNotice tone="success"><Link className="font-medium underline" href={associationHref(workspaceId,"orders")}>{t.order}: {saved.data.id}</Link></InlineNotice>:null}</AssociationListState>:null}
    <FormFooter><Button type="submit" className="min-h-11 md:min-h-9" disabled={!buyer||!guestsAvailable||!selected||unavailable||action.pending}>{u.reserveFor}</Button></FormFooter>
  </form>;
}
