"use client";

/** Native editors over the canonical generic catalogs and vertical tickets. [COMP:app-web/association] */
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { saveAssociationPlan,saveAssociationEvent,saveAssociationTicket,saveAssociationPromotion,type AssociationPlan,type AssociationEvent,type AssociationTicket,type AssociationPromotion,type AssociationPlanSave,type AssociationPromotionSave } from "@/lib/api/association";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { AssociationField as Field,AssociationChoice as Choice,useAssociationAction,associationInstant,associationLocalTime } from "./operator-controls";
import { AssociationMoneyField as Money, AssociationCatalogPicker } from "./workspace-ui";
import { ChoiceCards, FormFooter, FormSection as Group, InlineNotice, Segmented, SwitchField } from "./ui";

function catalogKey(name:string) { return name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,54) || `item-${crypto.randomUUID().slice(0,8)}`; }
const COMMON_CURRENCIES=["HKD","USD","CNY","JPY","SGD","EUR","GBP","AUD","TWD","MOP"];
function currencyList(known:readonly string[]) { return [...new Set([...known.filter(Boolean),...COMMON_CURRENCIES])]; }
function timezones():string[] { try { return typeof Intl.supportedValuesOf==="function"?Intl.supportedValuesOf("timeZone"):[]; } catch { return []; } }
function plusHours(local:string,hours:number):string { if(!local)return ""; const date=new Date(local); if(Number.isNaN(date.getTime()))return ""; date.setHours(date.getHours()+hours); return new Date(date.getTime()-date.getTimezoneOffset()*60_000).toISOString().slice(0,23); }

function ReferenceField({label,help,value,onChange,locked,maxLength}:{label:string;help:string;value:string;onChange:(v:string)=>void;locked:boolean;maxLength:number}) {
  return <Field label={label} help={help} value={value} onChange={onChange} required disabled={locked} maxLength={maxLength} autoComplete="off" />;
}

export function AssociationPlanForm({workspaceId,plan,disabled,onSaved,currencies=[]}:{workspaceId:string;plan?:AssociationPlan;disabled:boolean;onSaved:()=>void;currencies?:readonly string[]}) {
  const u=useT().associationPage.ux,t=useT().associationPage.manage,action=useAssociationAction(workspaceId);
  const [form,setForm]=useState<AssociationPlanSave>(()=>({key:plan?.planKey ?? "",name:plan?.name ?? "",currency:plan?.currency ?? currencies[0] ?? "",feeMinor:Number(plan?.feeMinor ?? 0),billingPeriod:plan?.billingPeriod ?? "annual",benefits:plan?.benefits ?? [],eligibilityNote:plan?.eligibilityNote ?? null,published:plan?.published ?? false,activeFrom:associationLocalTime(plan?.activeFrom),activeTo:associationLocalTime(plan?.activeTo),...(plan?.provider && plan.providerPlanId?{provider:plan.provider,providerPlanId:plan.providerPlanId}:{})}));
  const [customKey,setCustomKey]=useState(!!plan);
  const [validation,setValidation]=useState("");
  const set=<K extends keyof typeof form>(key:K,value:(typeof form)[K])=>setForm(old=>({...old,[key]:value}));
  const options=t.options;
  return <form className="space-y-5" onSubmit={e=>{e.preventDefault();if(disabled||!e.currentTarget.checkValidity())return;if(!Number.isSafeInteger(form.feeMinor)||form.feeMinor<0){setValidation(u.moneyInvalid);return;}if(form.activeFrom&&form.activeTo&&form.activeTo<=form.activeFrom){setValidation(u.dateInvalid);return;}setValidation("");void action.run(`${t.save}: ${form.name}`,async()=>{await saveAssociationPlan(workspaceId,{...form,benefits:form.benefits.map(v=>v.trim()).filter(Boolean),activeFrom:associationInstant(form.activeFrom ?? ""),activeTo:associationInstant(form.activeTo ?? "")});onSaved();},false);}}>
    <h3 className="sr-only">{plan?t.edit:t.newPlan}</h3><fieldset disabled={disabled||action.pending} className="grid min-w-0 gap-6">
      <Group title={u.basics}>
        <div className="col-span-full"><Field label={t.name} value={form.name} onChange={v=>setForm(old=>({...old,name:v,...(!customKey?{key:catalogKey(v)}:{})}))} required maxLength={200}/></div>
        <Money label={t.fee} currency={form.currency ?? ""} value={form.feeMinor} onChange={v=>set("feeMinor",v ?? Number.NaN)} required help={u.moneyHelp}/>
        <Field label={t.currency} value={form.currency} onChange={v=>set("currency",v.toUpperCase())} required maxLength={3} list={currencyList(currencies)} autoComplete="off"/>
        <ChoiceCards label={u.billedAs} value={form.billingPeriod} onChange={v=>set("billingPeriod",v)} columns={3} options={(["annual","monthly","one_time","lifetime","manual"] as const).map(value=>({value,label:options[value]}))}/>
        <div className="col-span-full"><SwitchField label={u.showOnWebsite} help={u.publicationHelp} checked={form.published} onChange={v=>set("published",v)}/></div>
        <div className="col-span-full"><Field label={t.benefits} multiline value={form.benefits.join("\n")} onChange={v=>set("benefits",v.split("\n"))}/></div>
      </Group>
      <Group title={u.moreOptions} collapsible>
        <div className="col-span-full"><Field label={u.whoCanJoin} multiline value={form.eligibilityNote ?? ""} onChange={v=>set("eligibilityNote",v)} maxLength={5000}/></div>
        <Field label={t.activeFrom} type="datetime-local" value={form.activeFrom ?? ""} onChange={v=>set("activeFrom",v)} help={t.timeHint}/>
        <Field label={t.activeTo} type="datetime-local" value={form.activeTo ?? ""} onChange={v=>set("activeTo",v)}/>
        <ReferenceField label={u.reference} help={u.referenceHelp} value={form.key} onChange={v=>{setCustomKey(true);set("key",v);}} locked={!!plan} maxLength={63}/>
      </Group>
    </fieldset>
    {validation?<p role="alert" className="text-sm text-destructive">{validation}</p>:null}{action.feedback}
    <FormFooter><Button type="submit" className="min-h-11 md:min-h-9" disabled={disabled||action.pending}>{t.save}</Button></FormFooter>
  </form>;
}

export function AssociationEventForm({workspaceId,event,disabled,onSaved,onDirtyChange}:{workspaceId:string;event?:AssociationEvent;disabled:boolean;onSaved:(record:AssociationEvent)=>void;onDirtyChange?:(dirty:boolean)=>void}) {
  const copy=useT().associationPage,u=copy.ux,t=copy.manage,action=useAssociationAction(workspaceId);
  const [form,setForm]=useState<Omit<AssociationEvent,"id">>(()=>({slug:event?.slug ?? "",title:event?.title ?? "",description:event?.description ?? "",startsAt:associationLocalTime(event?.startsAt),endsAt:associationLocalTime(event?.endsAt),timezone:event?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,mode:event?.mode ?? "venue",venue:event?.venue ?? null,onlineUrl:event?.onlineUrl ?? null,registrationOpensAt:associationLocalTime(event?.registrationOpensAt),registrationClosesAt:associationLocalTime(event?.registrationClosesAt),capacity:event?.capacity ?? null,status:event?.status ?? "draft",canonicalUrl:event?.canonicalUrl ?? null,programmeKey:event?.programmeKey ?? null,metadata:event?.metadata ?? {}}));
  const [baseline,setBaseline]=useState(form);
  const dirty=JSON.stringify(form)!==JSON.stringify(baseline);
  useEffect(()=>{onDirtyChange?.(dirty);},[dirty,onDirtyChange]);
  const [customKey,setCustomKey]=useState(!!event),[customEnd,setCustomEnd]=useState(!!event);
  const [validation,setValidation]=useState("");
  const set=<K extends keyof typeof form>(key:K,value:(typeof form)[K])=>setForm(old=>({...old,[key]:value}));
  const zones=timezones();
  return <form className="space-y-5" onSubmit={e=>{e.preventDefault();if(disabled||!e.currentTarget.checkValidity())return;if(!form.startsAt||!form.endsAt||form.endsAt<=form.startsAt||(form.registrationOpensAt&&form.registrationClosesAt&&form.registrationClosesAt<=form.registrationOpensAt)){setValidation(u.dateInvalid);return;}setValidation("");void action.run(`${t.save}: ${form.title}`,async()=>{const result=await saveAssociationEvent(workspaceId,{...form,status:event?.status ?? "draft",startsAt:associationInstant(form.startsAt)!,endsAt:associationInstant(form.endsAt)!,registrationOpensAt:associationInstant(form.registrationOpensAt ?? ""),registrationClosesAt:associationInstant(form.registrationClosesAt ?? ""),venue:form.mode==="online"?null:form.venue||null,onlineUrl:form.mode==="venue"?null:form.onlineUrl||null,canonicalUrl:form.canonicalUrl||null,programmeKey:form.programmeKey||null});setBaseline(form);onSaved(result.record);},false);}}>
    <h3 className="sr-only">{event?t.edit:t.newEvent}</h3><fieldset disabled={disabled||action.pending} className="grid min-w-0 gap-6">
      <Group title={u.basics}>
        <div className="col-span-full"><Field label={u.title} value={form.title} onChange={v=>setForm(old=>({...old,title:v,...(!customKey?{slug:catalogKey(v)}:{})}))} required maxLength={300}/></div>
        <Field label={t.start} type="datetime-local" value={form.startsAt} onChange={v=>setForm(old=>({...old,startsAt:v,...(!customEnd?{endsAt:plusHours(v,2)}:{})}))} required help={t.timeHint}/>
        <Field label={t.end} type="datetime-local" value={form.endsAt} onChange={v=>{setCustomEnd(true);set("endsAt",v);}} required/>
        <ChoiceCards label={u.where} value={form.mode} onChange={v=>set("mode",v)} columns={3} options={[{value:"venue",label:t.options.venue},{value:"online",label:t.options.online},{value:"hybrid",label:t.options.hybrid}]}/>
        {form.mode!=="online"?<Field label={t.venue} value={form.venue ?? ""} onChange={v=>set("venue",v)} maxLength={2000}/>:null}
        {form.mode!=="venue"?<Field label={u.meetingLink} type="url" value={form.onlineUrl ?? ""} onChange={v=>set("onlineUrl",v)} maxLength={2000}/>:null}
        <Field label={u.capacity} type="number" min={1} max={1000000} value={form.capacity===null?"":String(form.capacity)} onChange={v=>set("capacity",v?Number(v):null)} help={u.capacityHelp}/>
        <div className="col-span-full"><Field label={t.description} multiline value={form.description} onChange={v=>set("description",v)} maxLength={50000}/></div>

      </Group>
      <Group title={u.moreOptions} collapsible>
        <Field label={t.opens} type="datetime-local" value={form.registrationOpensAt ?? ""} onChange={v=>set("registrationOpensAt",v)}/>
        <Field label={t.closes} type="datetime-local" value={form.registrationClosesAt ?? ""} onChange={v=>set("registrationClosesAt",v)}/>
        {zones.length?<label className="flex min-w-0 flex-col gap-1 text-sm">{t.timezone}<SearchableSelect aria-label={t.timezone} value={form.timezone} onValueChange={v=>set("timezone",v)} items={zones.map(zone=>({value:zone,label:zone.replace(/_/g," ")}))} className="min-h-11 md:min-h-9"/></label>
          :<Field label={t.timezone} value={form.timezone} onChange={v=>set("timezone",v)} required maxLength={100}/>}
        <Field label={t.canonicalUrl} type="url" value={form.canonicalUrl ?? ""} onChange={v=>set("canonicalUrl",v)} maxLength={2000}/>
        <Field label={t.programmeKey} value={form.programmeKey ?? ""} onChange={v=>set("programmeKey",v)} maxLength={63}/>
        <ReferenceField label={u.reference} help={u.referenceHelp} value={form.slug} onChange={v=>{setCustomKey(true);set("slug",v);}} locked={!!event} maxLength={100}/>
      </Group>
    </fieldset>
    {validation?<p role="alert" className="text-sm text-destructive">{validation}</p>:null}{action.feedback}
    <FormFooter><Button type="submit" className="min-h-11 md:min-h-9" disabled={disabled||action.pending}>{event?t.save:copy.eventPage.saveDraft}</Button></FormFooter>
  </form>;
}

export function AssociationTicketForm({workspaceId,eventId,ticket,disabled,onSaved,currencies=[],onDirtyChange}:{workspaceId:string;eventId:string;ticket?:AssociationTicket;disabled:boolean;onSaved:()=>void;currencies?:readonly string[];onDirtyChange?:(dirty:boolean)=>void}) {
  const u=useT().associationPage.ux,t=useT().associationPage.manage,action=useAssociationAction(workspaceId);
  const [form,setForm]=useState(()=>({key:ticket?.key ?? "",name:ticket?.name ?? "",currency:ticket?.currency ?? currencies[0] ?? "",priceMinor:Number(ticket?.priceMinor ?? 0),memberPriceMinor:ticket?.memberPriceMinor===null||ticket?.memberPriceMinor===undefined?null:Number(ticket.memberPriceMinor),eligiblePlanKeys:ticket?.eligiblePlanKeys ?? [],eligibilityRequired:ticket?.eligibilityRequired ?? false,eligibilityScope:ticket?.eligibilityScope ?? "buyer" as AssociationTicket["eligibilityScope"],capacity:ticket?.capacity ?? null,perOrderLimit:ticket?.perOrderLimit ?? 10,saleStartsAt:associationLocalTime(ticket?.saleStartsAt),saleEndsAt:associationLocalTime(ticket?.saleEndsAt),status:ticket?.status ?? "draft"}));
  const [baseline,setBaseline]=useState(form);
  const dirty=JSON.stringify(form)!==JSON.stringify(baseline);
  useEffect(()=>{onDirtyChange?.(dirty);},[dirty,onDirtyChange]);
  const [customKey,setCustomKey]=useState(!!ticket);
  const [validation,setValidation]=useState("");
  const set=<K extends keyof typeof form>(key:K,value:(typeof form)[K])=>setForm(old=>({...old,[key]:value}));
  const statuses:AssociationTicket["status"][]=["draft","on_sale","closed",...(form.status==="sold_out"?["sold_out" as const]:[])];
  return <form className="space-y-5" onSubmit={e=>{e.preventDefault();if(disabled||!e.currentTarget.checkValidity())return;if(!Number.isSafeInteger(form.priceMinor)||form.priceMinor<0||(form.memberPriceMinor!==null&&(!Number.isSafeInteger(form.memberPriceMinor)||form.memberPriceMinor<0))){setValidation(u.moneyInvalid);return;}if(form.saleStartsAt&&form.saleEndsAt&&form.saleEndsAt<=form.saleStartsAt){setValidation(u.dateInvalid);return;}setValidation("");void action.run(`${t.save}: ${form.name}`,async()=>{await saveAssociationTicket(workspaceId,eventId,{...form,eligiblePlanKeys:form.eligiblePlanKeys.map(v=>v.trim()).filter(Boolean),saleStartsAt:associationInstant(form.saleStartsAt),saleEndsAt:associationInstant(form.saleEndsAt)});setBaseline(form);onSaved();},false);}}>
    <h3 className="sr-only">{ticket?t.edit:t.newTicket}</h3><fieldset disabled={disabled||action.pending} className="grid min-w-0 gap-6">
      <Group title={u.basics}>
        <div className="col-span-full"><Field label={t.name} value={form.name} onChange={v=>setForm(old=>({...old,name:v,...(!customKey?{key:catalogKey(v)}:{})}))} required maxLength={200}/></div>
        <Money label={t.price} currency={form.currency ?? ""} value={form.priceMinor} onChange={v=>set("priceMinor",v ?? Number.NaN)} required help={u.moneyHelp}/>
        <Field label={t.currency} value={form.currency} onChange={v=>set("currency",v.toUpperCase())} required maxLength={3} list={currencyList(currencies)} autoComplete="off"/>
        <Money label={t.memberPrice} currency={form.currency} value={form.memberPriceMinor} onChange={v=>set("memberPriceMinor",v)}/>
        <Field label={u.capacity} type="number" min={1} max={1000000} value={form.capacity===null?"":String(form.capacity)} onChange={v=>set("capacity",v?Number(v):null)} help={u.capacityHelp}/>
        <ChoiceCards label={u.saleStatus} value={form.status} onChange={v=>set("status",v)} columns={3} options={statuses.map(value=>({value,label:t.options[value]}))}/>
      </Group>
      <Group title={u.moreOptions} collapsible defaultOpen={form.eligibilityRequired}>
        <Field label={t.saleStart} type="datetime-local" value={form.saleStartsAt} onChange={v=>set("saleStartsAt",v)} help={t.timeHint}/>
        <Field label={t.saleEnd} type="datetime-local" value={form.saleEndsAt} onChange={v=>set("saleEndsAt",v)}/>
        <Field label={t.perOrder} type="number" min={1} max={1000} value={String(form.perOrderLimit)} onChange={v=>set("perOrderLimit",Number(v))} required/>
        <div className="col-span-full"><SwitchField label={u.membersOnly} help={u.membersOnlyHelp} checked={form.eligibilityRequired} onChange={v=>set("eligibilityRequired",v)}/></div>
        {form.eligibilityRequired?<><div className="col-span-full space-y-2"><p className="text-sm font-medium">{u.whichPlans}</p><AssociationCatalogPicker workspaceId={workspaceId} resource="plans" usePlanKeys selected={form.eligiblePlanKeys} onChange={eligiblePlanKeys=>set("eligiblePlanKeys",eligiblePlanKeys)}/></div>
          <div className="col-span-full space-y-1.5 text-sm"><p className="font-medium">{u.whoMustBeMember}</p><Segmented label={u.whoMustBeMember} value={form.eligibilityScope} onChange={v=>set("eligibilityScope",v)} options={[{value:"buyer",label:u.buyer},{value:"attendees",label:u.everyGuest},{value:"buyer_and_attendees",label:u.both}]}/></div></>:null}
        <ReferenceField label={u.reference} help={u.referenceHelp} value={form.key} onChange={v=>{setCustomKey(true);set("key",v);}} locked={!!ticket} maxLength={63}/>
      </Group>
    </fieldset>
    {validation?<p role="alert" className="text-sm text-destructive">{validation}</p>:null}{action.feedback}
    <FormFooter><Button type="submit" className="min-h-11 md:min-h-9" disabled={disabled||action.pending}>{t.save}</Button></FormFooter>
  </form>;
}

export function AssociationPromotionForm({workspaceId,promotion,disabled,onSaved,currencies=[]}:{workspaceId:string;promotion?:AssociationPromotion;disabled:boolean;onSaved:()=>void;currencies?:readonly string[]}) {
  const u=useT().associationPage.ux,t=useT().associationPage.manage,action=useAssociationAction(workspaceId);
  const [code,setCode]=useState("");
  const [targetEvent,setTargetEvent]=useState<string[]>([]);
  const [form,setForm]=useState<AssociationPromotionSave>(()=>({
    key:promotion?.key ?? "",name:promotion?.name ?? "",discountType:promotion?.discountType ?? "percentage",
    percentageBasisPoints:promotion?.percentageBasisPoints ?? 1000,amountMinor:promotion?.amountMinor===null||promotion?.amountMinor===undefined?null:Number(promotion.amountMinor),currency:promotion?.currency ?? null,
    buyQuantity:promotion?.buyQuantity ?? null,getQuantity:promotion?.getQuantity ?? null,targetKind:promotion?.targetKind ?? "event",targetIds:promotion?.targetIds ?? [],
    recurrenceMode:promotion?.recurrenceMode ?? "once",recurrenceCycles:promotion?.recurrenceCycles ?? null,applyMode:promotion?.applyMode ?? "each_eligible_item",
    validFrom:associationLocalTime(promotion?.validFrom),validTo:associationLocalTime(promotion?.validTo),
    maxUses:promotion?.maxUses ?? null,maxUsesPerContact:promotion?.maxUsesPerContact ?? null,
    combinesWithMemberPrice:promotion?.combinesWithMemberPrice ?? false,releaseOnFullRefund:promotion?.releaseOnFullRefund ?? false,
    status:promotion?.status ?? "active",
  }));
  const [customKey,setCustomKey]=useState(!!promotion);
  const [validation,setValidation]=useState("");
  const set=<K extends keyof typeof form>(key:K,value:(typeof form)[K])=>setForm(old=>({...old,[key]:value}));
  const percentage=form.percentageBasisPoints===null?"":String(form.percentageBasisPoints/100);
  return <form className="space-y-5" onSubmit={e=>{e.preventDefault();if(disabled||!e.currentTarget.checkValidity())return;if(!form.targetIds.some(id=>id.trim())){setValidation(u.noSelection);return;}if(form.discountType==="fixed_amount"&&(!Number.isSafeInteger(form.amountMinor)||!form.amountMinor||form.amountMinor<0)){setValidation(u.moneyInvalid);return;}if(form.validFrom&&form.validTo&&form.validTo<=form.validFrom){setValidation(u.dateInvalid);return;}setValidation("");
    const targetIds=form.targetIds.map(id=>id.trim()).filter(Boolean);
    void action.run(`${t.save}: ${form.name}`,async()=>{await saveAssociationPromotion(workspaceId,{...form,targetIds,
      validFrom:associationInstant(form.validFrom ?? ""),validTo:associationInstant(form.validTo ?? ""),
      ...(code.trim()?{code:code.trim()}:{}),
      percentageBasisPoints:form.discountType==="percentage"?form.percentageBasisPoints:null,
      amountMinor:form.discountType==="fixed_amount"?form.amountMinor:null,
      currency:form.discountType==="fixed_amount"?form.currency:null,
      buyQuantity:form.discountType==="buy_x_get_y"?form.buyQuantity:null,
      getQuantity:form.discountType==="buy_x_get_y"?form.getQuantity:null,
      recurrenceMode:form.targetKind==="plan"?form.recurrenceMode:"once",
      recurrenceCycles:form.targetKind==="plan"&&form.recurrenceMode==="repeating"?form.recurrenceCycles:null,
      applyMode:form.discountType==="buy_x_get_y"?"each_eligible_item":form.applyMode,
    });setCode("");onSaved();},false);}}>
    <h3 className="sr-only">{promotion?t.edit:t.newPromotion}</h3><fieldset disabled={disabled||action.pending} className="grid min-w-0 gap-6">
      <Group title={u.discount}>
        <Field label={t.name} value={form.name} onChange={v=>setForm(old=>({...old,name:v,...(!customKey?{key:catalogKey(v)}:{})}))} required maxLength={200}/>
        <Field label={promotion?t.replacementCode:t.promotionCode} value={code} onChange={setCode} required={!promotion} autoComplete="off" minLength={3} maxLength={100} help={promotion?u.codeHidden:t.promotionsHelp}/>
        <ChoiceCards label={t.discountType} value={form.discountType} onChange={v=>set("discountType",v)} columns={4} options={[{value:"percentage",label:u.percentOff},{value:"fixed_amount",label:u.amountOff},{value:"full",label:u.free},{value:"buy_x_get_y",label:t.options.buy_x_get_y}]}/>
        {form.discountType==="percentage"?<Field label={t.percentageDiscount} type="number" min={0.01} max={100} step={0.01} value={percentage} onChange={v=>set("percentageBasisPoints",v?Math.round(Number(v)*100):null)} required end="%"/>:null}
        {form.discountType==="fixed_amount"?<><Money label={t.fixedAmountMinor} currency={form.currency ?? ""} value={form.amountMinor} onChange={v=>set("amountMinor",v)} required/><Field label={t.currency} value={form.currency ?? ""} onChange={v=>set("currency",v.toUpperCase())} required maxLength={3} list={currencyList(currencies)} autoComplete="off"/></>:null}
        {form.discountType==="buy_x_get_y"?<><Field label={t.buyQuantity} type="number" min={1} max={1000} value={form.buyQuantity===null?"":String(form.buyQuantity)} onChange={v=>set("buyQuantity",v?Number(v):null)} required/><Field label={t.getQuantity} type="number" min={1} max={1000} value={form.getQuantity===null?"":String(form.getQuantity)} onChange={v=>set("getQuantity",v?Number(v):null)} required/></>:null}
      </Group>
      <Group title={u.selectTargets}>
        <div className="col-span-full space-y-1.5 text-sm"><p className="font-medium">{t.promotionTarget}</p><Segmented label={t.promotionTarget} value={form.targetKind} onChange={v=>{setForm(old=>({...old,targetKind:v,targetIds:[]}));setTargetEvent([]);}} options={[{value:"event",label:u.eventsNav},{value:"ticket",label:t.tickets},{value:"plan",label:t.plans}]}/></div>
        {form.targetKind==="ticket"?<div className="col-span-full space-y-2"><p className="text-sm font-medium">{u.chooseEvent}</p><AssociationCatalogPicker workspaceId={workspaceId} resource="events" single selected={targetEvent} onChange={setTargetEvent}/></div>:null}
        <AssociationCatalogPicker key={form.targetKind} workspaceId={workspaceId} resource={form.targetKind==="plan"?"plans":form.targetKind==="event"?"events":"tickets"} eventId={targetEvent[0]} selected={form.targetIds} onChange={ids=>set("targetIds",ids)}/>
        {form.targetKind==="ticket"&&!targetEvent.length&&form.targetIds.length?<p className="col-span-full text-sm">{u.selected}: {form.targetIds.length}</p>:null}
        <div className="col-span-full"><SwitchField label={u.activeSwitch} help={u.activeHelp} checked={form.status==="active"} onChange={v=>set("status",v?"active":"draft")}/></div>
        {form.status==="disabled"?<div className="col-span-full"><InlineNotice tone="warning">{t.options.disabled}</InlineNotice></div>:null}
      </Group>
      <Group title={u.moreOptions} collapsible>
        <Field label={u.validFrom} type="datetime-local" value={form.validFrom ?? ""} onChange={v=>set("validFrom",v)} help={t.timeHint}/>
        <Field label={u.validUntil} type="datetime-local" value={form.validTo ?? ""} onChange={v=>set("validTo",v)}/>
        <Field label={u.totalUses} type="number" min={1} max={1000000} value={form.maxUses===null?"":String(form.maxUses)} onChange={v=>set("maxUses",v?Number(v):null)} help={u.capacityHelp}/>
        <Field label={u.usesPerPerson} type="number" min={1} max={10000} value={form.maxUsesPerContact===null?"":String(form.maxUsesPerContact)} onChange={v=>set("maxUsesPerContact",v?Number(v):null)} help={u.capacityHelp}/>
        {form.targetKind==="plan"?<Choice label={u.discountLasts} value={form.recurrenceMode} values={["once","forever","repeating"]} labels={{once:u.firstPayment,forever:u.everyPayment,repeating:u.setNumber}} onChange={v=>set("recurrenceMode",v as typeof form.recurrenceMode)}/>:null}
        {form.targetKind==="plan"&&form.recurrenceMode==="repeating"?<Field label={t.recurrenceCycles} type="number" min={2} max={120} value={form.recurrenceCycles===null?"":String(form.recurrenceCycles)} onChange={v=>set("recurrenceCycles",v?Number(v):null)} required/>:null}
        {form.discountType!=="buy_x_get_y"?<Choice label={u.apply} value={form.applyMode} values={["once_per_order","each_eligible_item"]} onChange={v=>set("applyMode",v as typeof form.applyMode)}/>:null}
        <div className="col-span-full grid gap-3 md:grid-cols-2"><SwitchField label={u.stacksMemberPrice} checked={form.combinesWithMemberPrice} onChange={v=>set("combinesWithMemberPrice",v)}/><SwitchField label={u.releaseOnRefund} checked={form.releaseOnFullRefund} onChange={v=>set("releaseOnFullRefund",v)}/></div>
        <ReferenceField label={u.reference} help={u.referenceHelp} value={form.key} onChange={v=>{setCustomKey(true);set("key",v);}} locked={!!promotion} maxLength={63}/>
      </Group>
    </fieldset>
    {validation?<p role="alert" className="text-sm text-destructive">{validation}</p>:null}{action.feedback}
    <FormFooter><Button type="submit" className="min-h-11 md:min-h-9" disabled={disabled||action.pending}>{t.save}</Button>{promotion&&form.status!=="disabled"?<Button type="button" variant="ghost" className="min-h-11 md:min-h-9" disabled={disabled||action.pending} onClick={()=>set("status","disabled")}>{u.disableCode}</Button>:null}</FormFooter>
  </form>;
}
