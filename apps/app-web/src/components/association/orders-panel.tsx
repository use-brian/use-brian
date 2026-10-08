"use client";

/** Orders: filtered history with per-currency totals, line/guest drill-down and idempotent recovery. [COMP:app-web/association] */
import Link from "next/link";
import { useState } from "react";
import { CreditCard, SlidersHorizontal } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { changeAssociationOrder, getAssociationOrder, listAssociationOrders,
  type AssociationOrderDetail, type AssociationOrderFilters } from "@/lib/api/association";
import { associationOrdersCacheKey, associationPageCacheKey } from "@/lib/surface-prefetch";
import { markSurfaceCacheStale, invalidateSurfaceCache } from "@/lib/surface-cache";
import { crmRecordHref } from "@/lib/crm-view";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { ListSurfaceSkeleton } from "@/components/chrome/surface-skeleton";
import { AssociationCatalogPicker, associationMoney as formatMinor } from "./workspace-ui";
import { AssociationContactPicker, AssociationField, useAssociationContactSelection, useAssociationProjection } from "./operator-controls";
import { EmptyState, InlineNotice, PageHeader, Segmented, StatusPill, TechnicalDetails, associationDate } from "./ui";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Status=""|AssociationOrderDetail["status"];
type FilterDraft={eventId:string;contactId:string;createdAfter:string;createdBefore:string};
function initialFilterDraft(eventId:string):FilterDraft{return {eventId:UUID.test(eventId)?eventId:"",contactId:"",createdAfter:"",createdBefore:""};}
function instant(value:string):string|null{if(!value)return "";const time=Date.parse(value);return Number.isFinite(time)?new Date(time).toISOString():null;}

export function AssociationOrdersPanel({ workspaceId,initialEventId="" }: { workspaceId: string;initialEventId?:string }) {
  const t = useT().associationPage, u=t.ux;
  const [draft,setDraft]=useState<FilterDraft>(()=>initialFilterDraft(initialEventId));
  const [status,setStatus]=useState<Status>("");
  const [filters,setFilters]=useState<AssociationOrderFilters>(()=>UUID.test(initialEventId)?{eventId:initialEventId}:{});
  const [buyer,setBuyer]=useAssociationContactSelection(workspaceId),[showFilters,setShowFilters]=useState(!!initialEventId),[filterError,setFilterError]=useState(false);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1]!;
  const effective:AssociationOrderFilters={...filters,...(status?{status}:{})};
  const filterScope=JSON.stringify(effective);
  const { data, error, refresh } = useAssociationProjection(associationOrdersCacheKey(workspaceId, cursor,filterScope),
    () => listAssociationOrders(workspaceId, cursor ?? undefined,effective));
  const [pending, setPending] = useState<string | null>(null);
  const [saveError, setSaveError] = useState(false);
  const [expanded,setExpanded]=useState<string|null>(null);
  const detailId=data?.orders.some(order=>order.id===expanded)?expanded:null;
  const detail=useAssociationProjection(detailId?associationPageCacheKey(workspaceId,"order-detail",{id:detailId}):null,
    ()=>getAssociationOrder(workspaceId,detailId!));
  function applyFilters() {
    const after=instant(draft.createdAfter),before=instant(draft.createdBefore);
    if((draft.eventId&&!UUID.test(draft.eventId))||(draft.contactId&&!UUID.test(draft.contactId))
      ||after===null||before===null||(after&&before&&after>=before)){setFilterError(true);return;}
    setFilterError(false);setCursors([null]);
    setFilters({...(draft.eventId?{eventId:draft.eventId}:{}),...(draft.contactId?{contactId:draft.contactId}:{}),
      ...(after?{createdAfter:after}:{}),...(before?{createdBefore:before}:{})});
  }
  function clearFilters(){setBuyer(null);setDraft(initialFilterDraft(""));setFilters({});setStatus("");setCursors([null]);setFilterError(false);}
  function toggleDetails(orderId:string){setExpanded(previous=>previous===orderId?null:orderId);}
  async function act(orderId: string, action: "cancel" | "confirm-free") {
    if (pending || error) return;
    setPending(orderId);
    try {
      const label = action === "cancel" ? t.cancelOrder : t.confirmFree;
      if (!await confirmDialog({ title: label, description: action === "cancel" ? t.cancelOrderConfirm : t.confirmFreeDescription, confirmLabel: label, cancelLabel: t.cancel, variant: action==="cancel"?"destructive":"default" })) return;
      setSaveError(false);
      await changeAssociationOrder(workspaceId, orderId, action);
      markSurfaceCacheStale(`crm:${workspaceId}:`);
      markSurfaceCacheStale(`association-orders:${workspaceId}`);
      markSurfaceCacheStale(`association-module:${workspaceId}`);
      invalidateSurfaceCache(associationPageCacheKey(workspaceId,"order-detail",{id:orderId}));setExpanded(null);
      await refresh();
    } catch {
      invalidateSurfaceCache(`association-orders:${workspaceId}`);
      invalidateSurfaceCache(`crm:${workspaceId}:`);
      setExpanded(null);setSaveError(true);await refresh();
    }
    finally { setPending(null); }
  }
  const activeFilters=Object.keys(filters).length;
  return <section className="space-y-5" data-association-orders>
    <PageHeader title={t.orders} description={u.ordersHelp} actions={<><Button type="button" variant="outline" className="min-h-11 md:min-h-9" aria-expanded={showFilters} onClick={()=>setShowFilters(value=>!value)}><SlidersHorizontal aria-hidden className="size-4"/>{u.filters}{activeFilters?` (${activeFilters})`:""}</Button><Button type="button" className="min-h-11 md:min-h-9" variant="ghost" disabled={!!pending} onClick={() => void refresh()}>{t.refresh}</Button></>}>
      <Segmented label={t.orderStatus} value={status} onChange={value=>{setStatus(value);setCursors([null]);}} options={[{value:"" as Status,label:t.allOrderStatuses},...(Object.entries(t.orderStates) as [AssociationOrderDetail["status"],string][]).map(([value,label])=>({value:value as Status,label}))]}/>
    </PageHeader>
    {showFilters?<form className="grid gap-4 rounded-2xl border border-border bg-background p-4 md:grid-cols-2" onSubmit={event=>{event.preventDefault();applyFilters();}}>
      <details className="min-w-0 md:col-span-2"><summary className="min-h-11 cursor-pointer content-center text-sm font-medium md:min-h-8">{u.chooseEvent}{draft.eventId?` · ${u.selected}`:` · ${u.allEvents}`}</summary><AssociationCatalogPicker workspaceId={workspaceId} resource="events" single selected={draft.eventId?[draft.eventId]:[]} onChange={ids=>setDraft(previous=>({...previous,eventId:ids[0] ?? ""}))}/></details>
      <details className="min-w-0 md:col-span-2"><summary className="min-h-11 cursor-pointer content-center text-sm font-medium md:min-h-8">{u.filterBuyer}{buyer?` · ${buyer.name}`:""}</summary><AssociationContactPicker workspaceId={workspaceId} onSelect={row=>{setBuyer(row);setDraft(previous=>({...previous,contactId:row.id}));}}/>{draft.contactId?<Button type="button" variant="ghost" size="sm" className="min-h-11 md:min-h-8" onClick={()=>{setBuyer(null);setDraft(previous=>({...previous,contactId:""}));}}>{t.manage.contactClear}</Button>:null}</details>
      <AssociationField type="datetime-local" label={t.orderCreatedAfter} value={draft.createdAfter} onChange={createdAfter=>setDraft(previous=>({...previous,createdAfter}))}/>
      <AssociationField type="datetime-local" label={t.orderCreatedBefore} value={draft.createdBefore} onChange={createdBefore=>setDraft(previous=>({...previous,createdBefore}))}/>
      <details className="md:col-span-2"><summary className="min-h-11 cursor-pointer content-center text-sm text-muted-foreground md:min-h-8">{u.technical}</summary><div className="grid gap-3 pt-2 md:grid-cols-2"><AssociationField label={t.orderEventId} value={draft.eventId} onChange={eventId=>setDraft(previous=>({...previous,eventId}))}/><AssociationField label={t.orderContactId} value={draft.contactId} onChange={contactId=>{setBuyer(null);setDraft(previous=>({...previous,contactId}));}}/></div></details>
      <div className="flex flex-wrap gap-2 md:col-span-2"><Button type="submit" className="min-h-11 md:min-h-9">{t.applyOrderFilters}</Button><Button type="button" variant="outline" className="min-h-11 md:min-h-9" onClick={clearFilters}>{t.clearOrderFilters}</Button></div>
      {filterError?<p role="alert" className="text-sm text-destructive md:col-span-2">{t.orderFilterInvalid}</p>:null}
    </form>:null}
    {(error || saveError) && <InlineNotice tone="danger">{saveError ? t.orderSaveFailed : t.ordersLoadFailed}</InlineNotice>}
    {!data && !error && <ListSurfaceSkeleton rows={5} />}
    {data?.financialSummary?.length?<div className="grid gap-3 md:grid-cols-2" data-order-financial-summary>{data.financialSummary.map(summary=><section key={summary.currency} className="rounded-2xl border border-border bg-background p-4 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-semibold">{t.orderFinancialSummary}: {summary.currency}</h3><span className="text-xs text-muted-foreground">{t.settledOrders}: {summary.settledOrderCount} / {summary.orderCount}</span></div>
      <dl className="my-3 grid gap-3 sm:grid-cols-3">{[[t.gross,summary.grossMinor],[t.refundedAmount,summary.refundedMinor],[t.net,summary.netMinor]].map(([label,amount])=><div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums">{formatMinor(amount!,summary.currency)}</dd></div>)}</dl>
      <p className="text-xs text-muted-foreground">{t.subtotal}: {formatMinor(summary.subtotalMinor,summary.currency)} · {t.discount}: {formatMinor(summary.discountMinor,summary.currency)} · {t.pendingValue}: {formatMinor(summary.pendingMinor,summary.currency)}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t.providerSettlementExternal}</p>
    </section>)}</div>:null}
    {data?.orders.length === 0 && <EmptyState icon={CreditCard} title={t.noOrders}/>}
    {data?.orders.length?<div className="overflow-hidden rounded-2xl border border-border bg-background">
      <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_auto_auto] gap-x-4 border-b border-border bg-muted/30 px-4 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase md:grid"><span>{t.order}</span><span>{u.buyer}</span><span className="text-right">{t.total}</span><span>{t.manage.status}</span><span className="text-right">{u.actions}</span></div>
      <div className="divide-y divide-border">
      {data.orders.map(order => <article key={order.id} data-order-row className="px-4 py-3">
        <div className="grid gap-y-1 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_auto_auto] md:items-center md:gap-x-4">
          <div className="min-w-0"><p className="font-medium" title={order.id}>{u.orderNumber.replace("{id}",order.id.slice(0, 8))}</p><p className="text-xs text-muted-foreground">{associationDate(order.createdAt)}</p>{order.promotionSnapshot?<p className="text-xs text-muted-foreground">{t.manage.promotion}: {order.promotionSnapshot.name}</p>:null}</div>
          <div className="min-w-0 text-sm"><Link className="inline-flex min-h-11 items-center text-primary md:min-h-0" href={crmRecordHref(workspaceId, "contact", order.contactId)}>{t.openContact}</Link></div>
          <div className="text-sm font-semibold tabular-nums md:text-right">{formatMinor(order.totalMinor, order.currency)}{order.discountMinor!=="0"?<span className="block text-xs font-normal text-muted-foreground">{t.discount}: {formatMinor(order.discountMinor,order.currency)}</span>:null}</div>
          <div className="flex flex-wrap items-center gap-1.5"><StatusPill status={order.status} label={t.orderStates[order.status]}/>
            {order.refundState !== "none" && <span className="text-xs text-muted-foreground" data-order-refund>{t.refund}: {t.refundStates[order.refundState]}{order.refundedMinor !== "0" ? ` · ${t.refundedAmount}: ${formatMinor(order.refundedMinor, order.currency)}` : ""}</span>}
            {order.disputeState !== "none" && <span className="text-xs text-muted-foreground" data-order-dispute>{t.dispute}: {t.disputeStates[order.disputeState]}</span>}
            {order.reservationExpiresAt && order.status === "pending" && <span className="text-xs text-muted-foreground">{t.reservedUntil} {associationDate(order.reservationExpiresAt)}</span>}</div>
          <div className="flex flex-wrap items-center gap-2 pt-1 md:justify-end md:pt-0">
            <Button type="button" variant="ghost" size="sm" className="min-h-11 md:min-h-8" aria-expanded={expanded===order.id} disabled={detail.loading&&detailId===order.id} onClick={()=>void toggleDetails(order.id)}>{expanded===order.id?t.hideOrderDetails:t.orderDetails}</Button>
            {order.status === "pending" && <><Button size="sm" className="min-h-11 md:min-h-8" variant="outline" disabled={!!pending || !!error} onClick={() => void act(order.id, "cancel")}>{t.cancelOrder}</Button>
              {order.totalMinor === "0" && <Button size="sm" className="min-h-11 md:min-h-8" disabled={!!pending || !!error} onClick={() => void act(order.id, "confirm-free")}>{t.confirmFree}</Button>}</>}
          </div>
        </div>
        {expanded===order.id?<div className="mt-3 space-y-3 border-l-2 border-border pl-3" data-order-details>
          {detail.loading?<ListSurfaceSkeleton rows={2}/>:null}
          {detail.error?<div><p role="alert" className="text-sm text-destructive">{t.orderDetailsFailed}</p><Button type="button" variant="ghost" className="min-h-11 md:min-h-9" onClick={()=>void detail.refresh()}>{t.refresh}</Button></div>:null}
          {detail.data?.lines.map(line=><div key={line.id} className="text-sm"><p className="font-medium">{line.ticketName} · {t.quantity}: {line.quantity}</p>
            <p className="text-muted-foreground">{t.unitPrice}: {formatMinor(line.unitPriceMinor,order.currency)} · {t.lineTotal}: {formatMinor(line.lineTotalMinor,order.currency)}{line.discountMinor!=="0"?` · ${t.discount}: ${formatMinor(line.discountMinor,order.currency)}`:""}</p></div>)}
          {detail.data?.registrations.length?<div><h4 className="text-sm font-semibold">{t.attendees}</h4>{detail.data.registrations.map(registration=><p key={registration.id} className="flex items-center gap-2 text-sm">{registration.attendeeName}<StatusPill status={registration.status}/></p>)}</div>:null}
          <TechnicalDetails rows={[[t.order,order.id],...(order.providerReference?[[t.providerReference,`${order.provider} / ${order.providerReference}`] as [string,string]]:[])]}/>
        </div>:null}
      </article>)}
      </div>
    </div>:null}
    <div className="flex flex-wrap gap-2">
      <Button className="min-h-11 md:min-h-8" size="sm" variant="outline" disabled={cursors.length === 1 || !!pending} onClick={() => setCursors(previous => previous.slice(0, -1))}>{t.previous}</Button>
      <Button className="min-h-11 md:min-h-8" size="sm" variant="outline" disabled={!data?.nextCursor || !!error || !!pending || cursors.includes(data.nextCursor)} onClick={() => { if (data?.nextCursor) setCursors(previous => [...previous, data.nextCursor]); }}>{t.next}</Button>
    </div>
  </section>;
}
