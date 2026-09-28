"use client";

/** Admin (owner/admin only): module lifecycle, email mailboxes, integration keys, payment sync, activity log and privacy. [COMP:app-web/association] */
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { retryAssociationProviderReceipt } from "@/lib/api/association";
import { AssociationModuleControls } from "./module-controls";
import { AssociationPrivacyPanel } from "./privacy-panel";
import { AssociationMailboxPanel } from "./mailbox-panel";
import { AssociationCredentialsPanel } from "./credentials-panel";
import { associationHref } from "./navigation";
import { AssociationListState,useAssociationAction,useAssociationPage } from "./operator-controls";
import { EmptyState, PageHeader, ResponsiveTable, Segmented, StatusPill, TechnicalDetails, associationDate } from "./ui";

type AdminTab="general"|"mailboxes"|"keys"|"sync"|"activity"|"privacy";
const ADMIN_TABS:readonly AdminTab[]=["general","mailboxes","keys","sync","activity","privacy"];

function PaymentSync({workspaceId,canManage}:{workspaceId:string;canManage:boolean}) {
  const t=useT().associationPage,u=t.ux,m=t.manage,receipts=useAssociationPage(workspaceId,"receipts"),retry=useAssociationAction(workspaceId);
  async function retryReceipt(id:string) {
    const completed=await retry.run(u.retrySync,()=>retryAssociationProviderReceipt(workspaceId,id),{description:m.retryReceiptHelp});
    if(!completed)await receipts.refresh();
  }
  return <section className="space-y-4"><p className="text-sm text-muted-foreground">{u.paymentSyncHelp}</p>
    <AssociationListState {...receipts}>
      <ResponsiveTable rows={receipts.data?.items ?? []} rowKey={row=>row.id} rowData={row=>({"data-receipt-row":row.id})} empty={<EmptyState title={m.empty}/>}
        columns={[
          {key:"source",label:u.provider,cell:row=><span>{row.provider}<span className="block break-all text-xs text-muted-foreground">{row.eventId}</span></span>},
          {key:"state",label:m.status,cell:row=><span><StatusPill status={row.state}/>{row.errorCode?<span className="block text-xs text-destructive">{m.errorCode}: {row.errorCode}</span>:null}</span>},
          {key:"attempts",label:m.attempts,cell:row=>String(row.attempts)},
          {key:"target",label:t.order,hideBelowMd:true,cell:row=><span className="break-all text-xs">{row.orderId?`${t.order}: ${row.orderId}`:""}{row.entitlementId?`${m.memberships}: ${row.entitlementId}`:""}</span>},
        ]}
        actions={row=>canManage&&row.state==="needs_reconciliation"?<Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-8" disabled={retry.pending} onClick={()=>void retryReceipt(row.id)}>{u.retrySync}</Button>:null}/>
    </AssociationListState>{retry.feedback}</section>;
}

function ActivityLog({workspaceId}:{workspaceId:string}) {
  const t=useT().associationPage,u=t.ux,m=t.manage,activity=u.activityNames as Record<string,string>;
  const activityLabel=(action:string)=>activity[action] ?? action.replace(/[._]/g," ");
  const audit=useAssociationPage(workspaceId,"audit"),deliveries=useAssociationPage(workspaceId,"deliveries");
  return <div className="grid gap-6 lg:grid-cols-2">
    <section className="space-y-3"><h3 className="font-semibold">{u.changes}</h3><AssociationListState {...audit} compact><div className="divide-y divide-border rounded-2xl border border-border bg-background">
      {audit.data?.items.map(row=><article className="space-y-0.5 px-4 py-3 text-sm break-words" key={row.id}><p className="font-medium">{activityLabel(row.action)}</p><TechnicalDetails>{row.action} · {row.actorKind} · {row.id}</TechnicalDetails></article>)}
      {audit.data?.items.length===0?<p className="p-4 text-sm text-muted-foreground">{m.empty}</p>:null}</div></AssociationListState></section>
    <section className="space-y-3"><h3 className="font-semibold">{u.notificationsSent}</h3><AssociationListState {...deliveries} compact><div className="divide-y divide-border rounded-2xl border border-border bg-background">
      {deliveries.data?.items.map(row=><article className="space-y-0.5 px-4 py-3 text-sm break-words" key={row.id}><p className="flex flex-wrap items-center gap-2 font-medium">{row.eventType}<StatusPill status={row.status}/></p><p className="text-xs text-muted-foreground">{m.attempts}: {row.attempts} · {associationDate(row.occurredAt)} · {row.id}</p></article>)}
      {deliveries.data?.items.length===0?<p className="p-4 text-sm text-muted-foreground">{m.empty}</p>:null}</div></AssociationListState></section>
  </div>;
}

export function AssociationAdminPanel({workspaceId,tab}:{workspaceId:string;tab?:string}) {
  const t=useT().associationPage,u=t.ux,router=useRouter();
  const current:AdminTab=ADMIN_TABS.includes(tab as AdminTab)?tab as AdminTab:"general";
  const labels:Record<AdminTab,string>={general:u.general,mailboxes:t.admin.mailboxes,keys:t.admin.keys,sync:u.syncIssues,activity:u.activityLog,privacy:t.privacy.title};
  return <section className="space-y-5" data-association-admin>
    <PageHeader title={u.admin} description={u.adminHelp}><Segmented label={u.goTo} value={current} onChange={next=>router.replace(associationHref(workspaceId,"admin",{tab:next}))} options={ADMIN_TABS.map(id=>({value:id,label:labels[id]}))} className="flex-wrap"/></PageHeader>
    {current==="general"?<AssociationModuleControls workspaceId={workspaceId}/>:null}
    {current==="mailboxes"?<AssociationMailboxPanel workspaceId={workspaceId} disabled={false}/>:null}
    {current==="keys"?<AssociationCredentialsPanel workspaceId={workspaceId} disabled={false}/>:null}
    {current==="sync"?<PaymentSync workspaceId={workspaceId} canManage/>:null}
    {current==="activity"?<ActivityLog workspaceId={workspaceId}/>:null}
    {current==="privacy"?<AssociationPrivacyPanel workspaceId={workspaceId} disabled={false}/>:null}
  </section>;
}
