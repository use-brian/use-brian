"use client";

/** Promo codes: table of promotions and the secret-safe editor. [COMP:app-web/association] */
import { useState } from "react";
import { Plus, Tag } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import type { AssociationPromotion } from "@/lib/api/association";
import { Button } from "@/components/ui/button";
import { useAssociationModule } from "./module-controls";
import { AssociationListState,useAssociationPage } from "./operator-controls";
import { AssociationEditor, associationMoney } from "./workspace-ui";
import { AssociationPromotionForm } from "./catalog-forms";
import { EmptyState, InlineNotice, PageHeader, ResponsiveTable, StatusPill, associationDate } from "./ui";

export function AssociationPromotionsPanel({workspaceId,initialNew=false}:{workspaceId:string;initialNew?:boolean}) {
  const t=useT().associationPage,u=t.ux,m=t.manage,module=useAssociationModule(workspaceId);
  const canManage=!!module.data?.canManage&&!module.error;
  const rows=useAssociationPage(workspaceId,"promotions",{},canManage),plans=useAssociationPage(workspaceId,"plans",{},canManage);
  const [saved,setSaved]=useState(false),[editing,setEditing]=useState<AssociationPromotion|"new"|null>(initialNew?"new":null);
  const enabled=canManage&&module.data?.module.state==="enabled";
  const currencies=[...new Set((plans.data?.items ?? []).map(plan=>plan.currency))];
  const discount=(row:AssociationPromotion)=>row.discountType==="percentage"?`${(row.percentageBasisPoints ?? 0)/100}%`:row.discountType==="fixed_amount"&&row.amountMinor&&row.currency?associationMoney(row.amountMinor,row.currency):row.discountType==="buy_x_get_y"?`${m.options.buy_x_get_y} (${row.buyQuantity ?? "?"} + ${row.getQuantity ?? "?"})`:u.free;
  if(module.data&&!module.data.canManage)return <section className="space-y-5"><PageHeader title={u.promoCodes} description={u.promotionsHelp}/><InlineNotice tone="neutral">{t.ownerOnly}</InlineNotice></section>;
  if(editing)return <AssociationEditor title={editing==="new"?u.newPromoCode:editing.name} onClose={()=>setEditing(null)}><AssociationPromotionForm key={editing==="new"?"new":editing.id} workspaceId={workspaceId} promotion={editing==="new"?undefined:editing} currencies={currencies} disabled={!enabled||!!rows.error} onSaved={()=>{setEditing(null);setSaved(true);void rows.refresh();}}/></AssociationEditor>;
  return <section className="space-y-5">
    <PageHeader title={u.promoCodes} description={u.promotionsHelp} actions={<Button type="button" className="min-h-11 md:min-h-9" disabled={!enabled||!!rows.error} onClick={()=>{setSaved(false);setEditing("new");}}><Plus aria-hidden className="size-4"/>{u.newPromoCode}</Button>}/>
    {module.data&&module.data.module.state!=="enabled"?<InlineNotice tone="warning">{t.stateDescriptions[module.data.module.state]}</InlineNotice>:null}
    {saved?<InlineNotice tone="success">{u.saved}</InlineNotice>:null}
    <AssociationListState {...rows}>
      <ResponsiveTable rows={rows.data?.items ?? []} rowKey={row=>row.id} rowData={row=>({"data-promotion-row":row.id})} onRowClick={enabled&&!rows.error?row=>setEditing(row):undefined} empty={<EmptyState icon={Tag} title={u.emptyPromotions}/>}
        columns={[
          {key:"name",label:m.name,primary:true,cell:row=><span>{row.name}<span className="block text-xs font-normal text-muted-foreground">{m.codeProtected}</span></span>},
          {key:"discount",label:t.discount,cell:row=>discount(row)},
          {key:"target",label:m.promotionTarget,cell:row=>format(u.targetsCount,{count:row.targetIds.length,kind:m.options[row.targetKind]})},
          {key:"used",label:u.used,cell:row=>row.redeemedUses===null?u.usageUnavailable:row.maxUses===null?String(row.redeemedUses):format(u.usesSummary,{used:row.redeemedUses,limit:row.maxUses})},
          {key:"valid",label:u.validUntil,hideBelowMd:true,cell:row=>row.validTo?associationDate(row.validTo,"date"):m.unlimited},
          {key:"status",label:m.status,cell:row=><StatusPill status={row.status}/>},
        ]}
        actions={row=><Button type="button" size="sm" variant="ghost" className="min-h-11 md:min-h-8" disabled={!enabled||!!rows.error} onClick={()=>setEditing(row)}>{m.edit}</Button>}/>
    </AssociationListState>
  </section>;
}
