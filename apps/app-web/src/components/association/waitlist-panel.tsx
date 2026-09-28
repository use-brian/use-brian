"use client";

/** Waitlist: who is waiting, with explicit place offers that keep a stable request identity. [COMP:app-web/association] */
import Link from "next/link";
import { useState } from "react";
import { ListChecks } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { offerAssociationPlace,type AssociationWaitlistRow } from "@/lib/api/association";
import { crmRecordHref } from "@/lib/crm-view";
import { Button } from "@/components/ui/button";
import { useAssociationModule } from "./module-controls";
import { AssociationField,AssociationToggle,AssociationListState,AssociationIntentNotice,useAssociationPage,useAssociationIntent,useAssociationAction } from "./operator-controls";
import { AssociationEditor } from "./workspace-ui";
import { associationHref } from "./navigation";
import { EmptyState, FormFooter, InlineNotice, PageHeader, ResponsiveTable, StatusPill, SwitchField, associationDate } from "./ui";

export function AssociationWaitlistOffer({workspaceId,row,enabled}:{workspaceId:string;row:AssociationWaitlistRow;enabled:boolean}) {
  const t=useT().associationPage,u=t.ux,action=useAssociationAction(workspaceId),intent=useAssociationIntent(workspaceId,"offer",row.id);
  const [minutes,setMinutes]=useState("20"),[member,setMember]=useState(false),[orderId,setOrderId]=useState<string|null>(null);
  // A retained request may be replayed for its receipt even after module disable.
  const allowed=(enabled&&row.waitlistState==="waiting")||!!intent.reference;
  return <form className="space-y-4" onSubmit={e=>{e.preventDefault();if(!allowed)return;void action.run(`${u.sendOffer}: ${row.contactName}`,async()=>{const result=await offerAssociationPlace(workspaceId,row.id,{promotionId:intent.identity(),reservationMinutes:Number(minutes),useMemberPrice:member});setOrderId(result.offer.orderId);});}}>
    <p className="text-sm text-muted-foreground">{row.contactName}</p>
    <fieldset disabled={!allowed||action.pending} className="grid gap-4 md:grid-cols-2">
      <AssociationField label={u.holdFor} type="number" min={1} max={120} required value={minutes} onChange={setMinutes}/>
      <SwitchField label={t.manage.memberPricing} checked={member} onChange={setMember}/>
    </fieldset>{action.feedback}<AssociationIntentNotice reference={intent.reference} onReset={intent.reset} disabled={action.pending}/>
    {orderId?<InlineNotice tone="success"><Link className="font-medium underline" href={associationHref(workspaceId,"orders")}>{t.order}: {orderId}</Link></InlineNotice>:null}
    <FormFooter><Button type="submit" className="min-h-11 md:min-h-9" disabled={!allowed||action.pending}>{u.sendOffer}</Button></FormFooter>
  </form>;
}
export function AssociationWaitlistPanel({workspaceId}:{workspaceId:string}) {
  const t=useT().associationPage,u=t.ux,m=t.manage,module=useAssociationModule(workspaceId);
  const [includeClosed,setIncludeClosed]=useState(false),[selected,setSelected]=useState<AssociationWaitlistRow|null>(null);
  const rows=useAssociationPage(workspaceId,"waitlist",{includeClosed});
  const enabled=module.data?.module.state==="enabled"&&!module.error&&!rows.error;
  if(selected)return <AssociationEditor title={`${m.offer}: ${selected.contactName}`} onClose={()=>setSelected(null)}><AssociationWaitlistOffer key={selected.id} workspaceId={workspaceId} row={rows.data?.items.find(r=>r.id===selected.id) ?? selected} enabled={enabled}/></AssociationEditor>;
  return <section className="space-y-5">
    <PageHeader title={m.waitlist} description={u.waitlistHelp} actions={<AssociationToggle label={m.includeClosed} checked={includeClosed} onChange={setIncludeClosed}/>}/>
    {module.data&&module.data.module.state!=="enabled"?<InlineNotice tone="warning">{t.stateDescriptions[module.data.module.state]}</InlineNotice>:null}
    <AssociationListState {...rows}>
      <ResponsiveTable rows={rows.data?.items ?? []} rowKey={row=>row.id} rowData={row=>({"data-waitlist-row":row.id})} empty={<EmptyState icon={ListChecks} title={u.emptyWaitlist}/>}
        columns={[
          {key:"person",label:u.person,cell:row=><Link className="inline-flex min-h-11 items-center font-medium text-primary md:min-h-0" href={crmRecordHref(workspaceId,"contact",row.contactId)}>{row.contactName}</Link>},
          {key:"state",label:m.status,cell:row=><StatusPill status={row.waitlistState}/>},
          {key:"expires",label:u.offerExpires,cell:row=>row.reservationExpiresAt?associationDate(row.reservationExpiresAt):""},
          {key:"order",label:t.order,cell:row=>row.orderId?<Link className="break-all text-primary" href={associationHref(workspaceId,"orders")}>{row.orderId}</Link>:""},
        ]}
        actions={row=>row.waitlistState==="waiting"?<Button type="button" size="sm" className="min-h-11 md:min-h-8" disabled={!!rows.error} onClick={()=>setSelected(row)}>{m.offer}</Button>:null}/>
    </AssociationListState>
  </section>;
}
