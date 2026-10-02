"use client";
/** Draft -> human preview -> canonical publication. [COMP:app-web/association] */
import { useState } from "react";
import type { MembershipCatalogueDocument, WebsiteMembershipPlan, MembershipLocale, MembershipSite } from "@/lib/api/association";
import { useT } from "@/lib/i18n/client";
import { useCachedResource } from "@/lib/surface-cache";
import { associationPageCacheKey } from "@/lib/surface-prefetch";
import { getMembershipCatalogueDraft, saveMembershipCatalogueDraft, publishMembershipCatalogue, websiteSiteLabel } from "@/lib/api/association";
import { format } from "@/lib/i18n/format";
import { useWebsiteSiteNames } from "./website/website-status";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { AssociationField as Field, AssociationChoice as Choice, AssociationToggle as Toggle, AssociationListState, useAssociationAction, useAssociationPage } from "./operator-controls";
import { useAssociationModule } from "./module-controls";
import { InlineNotice, PageHeader } from "./ui";
import { associationLocalTime, associationInstant } from "./operator-controls";

const locales = ["en", "zh-Hant", "zh-Hans"] as const;
const emptyCopy = () => ({ name: "", summary: "", audience: "", badge: "", description: "", eligibility: "", benefits: [] as string[], actionLabel: "", billingLabel: "", documents: [] as {label:string;href:string}[] });
const copies = () => ({ en: emptyCopy(), "zh-Hant": emptyCopy(), "zh-Hans": emptyCopy() });
const emptyPage = () => ({ title: "", intro: "", groups: [{ id: "plans", title: "", intro: "" }], sections: [] as MembershipCatalogueDocument["pages"]["oasa"]["en"]["sections"] });
const pages = () => ({ en: emptyPage(), "zh-Hant": emptyPage(), "zh-Hans": emptyPage() });
function blank(): MembershipCatalogueDocument { return { schemaVersion: 1, plans: [], pages: { oasa: pages(), sea: pages() } }; }
const lines = (value: string) => value.split("\n");

export function MembershipPublishingPanel({ workspaceId }: { workspaceId: string }) {
  const t = useT().associationPage, c = t.publishing;
  const module = useAssociationModule(workspaceId), manage = !!module.data?.canManage, commerceOn = module.data?.module.state === "enabled";
  const names = useWebsiteSiteNames(workspaceId, manage);
  const read = useCachedResource(manage ? associationPageCacheKey(workspaceId, "membership-catalogue") : null, () => getMembershipCatalogueDraft(workspaceId));
  const promotions = useAssociationPage(workspaceId, "promotions", {}, manage);
  const action = useAssociationAction(workspaceId);
  const [editing, setEditing] = useState<{version:number;document:MembershipCatalogueDocument}|null>(null);
  const [locale, setLocale] = useState<MembershipLocale>("en"), [brand, setBrand] = useState<"shared"|MembershipSite>("shared"), [chosenSite, setSite] = useState<string>("");
  const [feeInput, setFeeInput] = useState<Record<string,string>>({});
  const [preview, setPreview] = useState(false), [selected, setSelected] = useState(0);
  const doc = editing?.document ?? read.data?.document;
  // Sites come from the catalogue document and the websites that read it, never from code.
  const sites = [...new Set([...Object.keys(doc?.pages ?? {}), ...Object.keys(read.data?.observations ?? {})])].sort() as MembershipSite[];
  const site = (sites.includes(chosenSite as MembershipSite) ? chosenSite : sites[0] ?? "") as MembershipSite;
  const plan = doc?.plans[selected];
  const patch = (fn:(document:MembershipCatalogueDocument)=>void) => setEditing(old => { if (!old) return old; const next = structuredClone(old); fn(next.document); return next; });
  const setPlan = <K extends keyof WebsiteMembershipPlan>(key:K, value:WebsiteMembershipPlan[K]) => patch(document => { document.plans[selected][key] = value; });
  const copy = plan && (brand === "shared" ? plan.i18n[locale] : {...plan.i18n[locale],...plan.overrides[brand]?.[locale]});
  const patchCopy = (fn:(value:ReturnType<typeof emptyCopy>)=>void) => patch(document => {
    const p = document.plans[selected];
    if (brand === "shared") fn(p.i18n[locale]);
    else {
      const before = {...p.i18n[locale],...p.overrides[brand]?.[locale]}; const after = structuredClone(before); fn(after);
      const changes = Object.fromEntries(Object.entries(after).filter(([key,value])=>JSON.stringify(value)!==JSON.stringify(before[key as keyof typeof before])));
      p.overrides[brand] ??= {}; p.overrides[brand]![locale] = {...p.overrides[brand]![locale],...changes};
    }
  });
  const page = doc?.pages[site][locale];
  const patchPage = (fn:(value:NonNullable<typeof page>)=>void) => patch(document => fn(document.pages[site][locale]));
  async function save() { if (!editing) return; const current = editing; if (await action.run(c.draft, () => saveMembershipCatalogueDraft(workspaceId, current.version, current.document), false)) { setEditing(null); setFeeInput({}); setPreview(false); await read.refresh(); } }
  async function publish() { if (!read.data || editing || !preview) return; if (await action.run(c.publish, () => publishMembershipCatalogue(workspaceId, read.data!.version), { description: c.review })) { setPreview(false); await read.refresh(); } }
  return <section className="space-y-5">
    <PageHeader title={c.title} description={c.help}/>
    {!manage ? <InlineNotice tone="neutral">{t.ux.readOnly}</InlineNotice> : <AssociationListState {...read}>
      {read.data && <>
                <div className="flex flex-wrap gap-3" role="status">{read.data.publishedRevision > 0 ? Object.keys(read.data.observations).length === 0 ? <p className="text-sm">{t.content.statusNotRead}</p> : Object.keys(read.data.observations).map(s => <p key={s} className="text-sm">{format(read.data!.observations[s]?.revision === read.data!.publishedRevision ? t.content.observed : t.content.pending, { site: websiteSiteLabel(s, names) })}</p>) : null}</div>
        {!commerceOn && module.data ? <InlineNotice tone="neutral">{c.publishNeedsModule}</InlineNotice> : null}
        {!doc && <InlineNotice tone="neutral">{c.empty}</InlineNotice>}
        <div className="flex flex-wrap gap-2">
          {!editing && <Button className="min-h-11" onClick={() => {setFeeInput({});setEditing({version:read.data!.version, document:structuredClone(doc ?? blank())});setPreview(false);}}>{doc ? c.edit : c.create}</Button>}
          {editing && <><Button className="min-h-11" disabled={action.pending || Object.values(feeInput).some(value=>!/^\d+(?:\.\d{1,2})?$/.test(value))} onClick={() => void save()}>{c.draft}</Button><Button className="min-h-11" variant="outline" onClick={async () => { if (await confirmDialog({title:t.ux.cancelEdit,description:t.ux.cancelHelp,confirmLabel:t.cancel,cancelLabel:t.ux.keepEditing})) { setEditing(null); setFeeInput({}); } }}>{t.cancel}</Button></>}
          {!editing && doc && <Button className="min-h-11" variant="outline" onClick={() => setPreview(!preview)}>{c.preview}</Button>}
          {preview && !editing && <Button className="min-h-11" disabled={!commerceOn || !!read.error || action.pending || !!read.data.issues.length || read.data.version === read.data.publishedRevision} onClick={() => void publish()}>{c.publish}</Button>}
        </div>
        {action.feedback}{read.data.issues.length > 0 && <ul role="alert" className="list-inside list-disc text-sm text-destructive">{read.data.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
        {doc && <div className="grid gap-3 md:grid-cols-3"><Choice label={c.locale} value={locale} values={locales} labels={{en:"English","zh-Hant":"繁體中文","zh-Hans":"简体中文"}} onChange={v=>setLocale(v as MembershipLocale)}/><Choice label={c.sites} value={site} values={sites} labels={Object.fromEntries(sites.map(key=>[key,websiteSiteLabel(key,names)]))} onChange={v=>setSite(v as MembershipSite)}/></div>}
        {!editing && !preview && doc && <div className="grid gap-3 md:grid-cols-2">{doc.plans.map((p,i)=><article key={p.key} className="space-y-3 rounded-xl border p-4"><h3 className="font-semibold">{(p.overrides[site]?.[locale]?.name??p.i18n[locale].name)}</h3><p className="text-sm">{p.currency} {p.feeMinor/100} · {c[p.billingPeriod]}</p><p className="text-sm text-muted-foreground">{p.sites.map(s=>s.toUpperCase()).join(" · ")} · {p.availability==="enquiry"?c.enquiryStatus:c[p.availability]}</p><Button className="min-h-11" variant="outline" disabled={module.data?.module.state!=="enabled"} onClick={()=>{setFeeInput({});setSelected(i);setEditing({version:read.data!.version,document:structuredClone(doc)});}}>{c.edit}</Button></article>)}</div>}
        {preview && doc && <div className="grid min-w-0 gap-4 lg:grid-cols-2">{([c.before,c.after] as const).map((title,index)=><div className="min-w-0 rounded-xl border p-4" key={title}><h3 className="font-semibold">{title}</h3><CataloguePreview document={index===0?read.data!.published:doc} locale={locale} site={site} promotionNames={Object.fromEntries((promotions.data?.items??[]).map(p=>[p.id,p.name]))}/></div>)}</div>}
        {editing && doc && <fieldset disabled={action.pending} className="min-w-0 space-y-6">
          <div className="flex flex-wrap gap-2">{doc.plans.map((p,i)=><Button className="min-h-11 max-w-full" key={i} variant={i===selected?"default":"outline"} onClick={()=>setSelected(i)}>{p.i18n[locale].name || p.key || t.manage.newPlan}</Button>)}
            <Button className="min-h-11" variant="outline" onClick={()=>{setSelected(doc.plans.length);patch(d=>d.plans.push({key:`plan-${d.plans.length+1}`,currency:"HKD",feeMinor:0,billingPeriod:"annual",activeFrom:null,activeTo:null,availability:"closed",application:{type:"application",proposerRequired:false,codeOfConduct:true},sites:["oasa","sea"],group:"plans",order:d.plans.length,i18n:copies(),overrides:{},promotionId:null}));}}>{t.manage.newPlan}</Button>
          </div>
          {plan && copy && <section className="grid min-w-0 gap-4 rounded-xl border p-4 md:grid-cols-2">
            <Field label={t.manage.key} value={plan.key} disabled={!!plan.planId} onChange={v=>setPlan("key",v)}/>
            <Field label={t.manage.fee} type="number" min={0} step="0.01" value={feeInput[plan.key] ?? String(plan.feeMinor/100)} onChange={v=>{setFeeInput(old=>({...old,[plan.key]:v}));if(/^\d+(?:\.\d{1,2})?$/.test(v))setPlan("feeMinor",Math.round(Number(v)*100));}}/>
            <Choice label={t.manage.billing} value={plan.billingPeriod} values={["annual","one_time","lifetime","manual"]} labels={{annual:c.annual,one_time:c.one_time,lifetime:c.lifetime,manual:c.manual}} onChange={v=>setPlan("billingPeriod",v as WebsiteMembershipPlan["billingPeriod"])}/>
            <Choice label={t.manage.status} value={plan.availability} values={["public","invitation","enquiry","closed"]} labels={{public:c.public,invitation:c.invitation,enquiry:c.enquiryStatus,closed:c.closed}} onChange={v=>setPlan("availability",v as WebsiteMembershipPlan["availability"])}/>
            <Choice label={c.type} value={plan.application.type} values={["application","enquiry"]} labels={{application:c.application,enquiry:c.enquiry}} onChange={v=>setPlan("application",{...plan.application,type:v as "application"|"enquiry"})}/>
            <Field label={c.group} value={plan.group} onChange={v=>setPlan("group",v)}/><Field label={c.order} type="number" value={String(plan.order)} onChange={v=>setPlan("order",Number(v))}/>
            <Field label={c.activeFrom} type="datetime-local" value={associationLocalTime(plan.activeFrom)} onChange={v=>setPlan("activeFrom",associationInstant(v))}/><Field label={c.activeTo} type="datetime-local" value={associationLocalTime(plan.activeTo)} onChange={v=>setPlan("activeTo",associationInstant(v))}/>
            {sites.map(s=><Toggle key={s} label={`${c.sites}: ${websiteSiteLabel(s,names)}`} checked={plan.sites.includes(s)} onChange={v=>setPlan("sites",v?[...plan.sites,s]:plan.sites.filter(item=>item!==s))}/>)}
            <Toggle label={c.proposer} checked={plan.application.proposerRequired} onChange={v=>setPlan("application",{...plan.application,proposerRequired:v})}/>
            <Choice label={c.promotion} value={plan.promotionId ?? "none"} values={["none",...(promotions.data?.items.filter(p=>p.targetKind==="plan"&&!!plan.planId&&p.targetIds.includes(plan.planId)).map(p=>p.id)??[])]} labels={{none:c.noPromotion,...Object.fromEntries((promotions.data?.items??[]).map(p=>[p.id,p.name]))}} onChange={v=>setPlan("promotionId",v==="none"?null:v)}/>
            <Choice label={c.wordingFor} value={brand} values={["shared",...sites]} labels={{shared:c.shared,...Object.fromEntries(sites.map(key=>[key,format(c.siteOverride,{site:websiteSiteLabel(key,names)})]))}} onChange={v=>setBrand(v as typeof brand)}/>
            {brand!=="shared"&&<Button variant="outline" className="min-h-11" onClick={()=>patch(d=>{delete d.plans[selected].overrides[brand]?.[locale];})}>{c.inherit}</Button>}
            {(["name","summary","audience","badge","description","eligibility","actionLabel","billingLabel"] as const).map(key=><Field key={key} label={c[key]} value={copy[key]} multiline={["summary","description","eligibility"].includes(key)} onChange={v=>patchCopy(value=>{value[key]=v;})}/>)}
            <Field label={c.benefits} multiline value={copy.benefits.join("\n")} onChange={v=>patchCopy(value=>{value.benefits=lines(v);})}/>
            <div className="space-y-3 md:col-span-2"><h4>{c.documents}</h4>{copy.documents.map((link,i)=><div className="grid gap-2 md:grid-cols-3" key={i}><Field label={c.name} value={link.label} onChange={v=>patchCopy(value=>{value.documents[i].label=v;})}/><Field label={c.url} value={link.href} onChange={v=>patchCopy(value=>{value.documents[i].href=v;})}/><Button variant="outline" className="min-h-11" onClick={()=>patchCopy(value=>{value.documents.splice(i,1);})}>{c.remove}</Button></div>)}<Button variant="outline" className="min-h-11" onClick={()=>patchCopy(value=>value.documents.push({label:"",href:"/"}))}>{c.add}</Button></div>
          </section>}
          {page&&<section className="space-y-4 rounded-xl border p-4"><h3 className="font-semibold">{c.pages}: {site.toUpperCase()}</h3><Field label={c.titleField} value={page.title} onChange={v=>patchPage(p=>{p.title=v;})}/><Field label={c.intro} value={page.intro} multiline onChange={v=>patchPage(p=>{p.intro=v;})}/><p className="text-sm">{c.groupHelp}</p>
            {page.groups.map((group,i)=><div className="grid gap-2 md:grid-cols-3" key={i}><Field label={c.group} value={group.id} onChange={v=>patchPage(p=>{p.groups[i].id=v;})}/><Field label={c.titleField} value={group.title} onChange={v=>patchPage(p=>{p.groups[i].title=v;})}/><Field label={c.intro} value={group.intro} onChange={v=>patchPage(p=>{p.groups[i].intro=v;})}/><Button variant="outline" className="min-h-11" onClick={()=>patchPage(p=>{p.groups.splice(i,1);})}>{c.remove}</Button></div>)}
            <Button variant="outline" className="min-h-11" onClick={()=>patchPage(p=>p.groups.push({id:`group-${p.groups.length+1}`,title:"",intro:""}))}>{c.add}: {c.group}</Button>
            {page.sections.map((section,i)=><div className="space-y-3 border-t border-border pt-3" key={i}><Field label={c.titleField} value={section.title} onChange={v=>patchPage(p=>{p.sections[i].title=v;})}/><Field label={c.paragraphs} multiline value={section.paragraphs.join("\n")} onChange={v=>patchPage(p=>{p.sections[i].paragraphs=lines(v);})}/><Field label={c.bullets} multiline value={section.bullets.join("\n")} onChange={v=>patchPage(p=>{p.sections[i].bullets=lines(v);})}/>
              {section.image&&<><Field label={c.url} value={section.image.src} onChange={v=>patchPage(p=>{p.sections[i].image!.src=v;})}/><Field label={c.imageAlt} value={section.image.alt} onChange={v=>patchPage(p=>{p.sections[i].image!.alt=v;})}/></>}{section.documents.map((link,j)=><div className="grid gap-2 md:grid-cols-2" key={j}><Field label={c.name} value={link.label} onChange={v=>patchPage(p=>{p.sections[i].documents[j].label=v;})}/><Field label={c.url} value={link.href} onChange={v=>patchPage(p=>{p.sections[i].documents[j].href=v;})}/><Button variant="outline" className="min-h-11" onClick={()=>patchPage(p=>{p.sections[i].documents.splice(j,1);})}>{c.remove}</Button></div>)}<Button variant="outline" className="min-h-11" onClick={()=>patchPage(p=>p.sections[i].documents.push({label:"",href:"/"}))}>{c.add}: {c.documents}</Button><Button variant="outline" className="min-h-11" onClick={()=>patchPage(p=>{p.sections.splice(i,1);})}>{c.remove}</Button></div>)}
            <Button variant="outline" className="min-h-11" onClick={()=>patchPage(p=>p.sections.push({id:`section-${p.sections.length+1}`,title:"",paragraphs:[],bullets:[],documents:[]}))}>{c.addSection}</Button>
            {page.newsletter&&<div className="space-y-2"><h4>{c.newsletter}</h4>{(["name","summary","actionLabel"] as const).map(key=><Field key={key} label={c[key]} value={page.newsletter![key]} onChange={v=>patchPage(p=>{p.newsletter![key]=v;})}/>)}<Field label={c.benefits} multiline value={page.newsletter.benefits.join("\n")} onChange={v=>patchPage(p=>{p.newsletter!.benefits=lines(v);})}/></div>}
          </section>}
        </fieldset>}
      </>}
    </AssociationListState>}
  </section>;
}

function CataloguePreview({document,site,locale,promotionNames={}}:{promotionNames?:Record<string,string>;document:MembershipCatalogueDocument|null;site:MembershipSite;locale:MembershipLocale}) {
  const c = useT().associationPage.publishing;
  if(!document)return null;
  const page=document.pages[site][locale];
  return <div className="space-y-4 break-words"><h4>{page.title}</h4><p>{page.intro}</p>{page.groups.map(group=><div key={group.id}><h4>{group.title}</h4><p>{group.intro}</p></div>)}{document.plans.filter(p=>p.sites.includes(site)).sort((a,b)=>a.order-b.order).map(p=>{
    const copy={...p.i18n[locale],...p.overrides[site]?.[locale]};
    return <article className="space-y-2 rounded-xl border p-3" key={p.key}><h4 className="font-semibold">{copy.name}</h4><p>{p.currency} {p.feeMinor/100} · {c[p.billingPeriod]} · {p.availability === "enquiry" ? c.enquiryStatus : c[p.availability]}</p><p>{c.type}: {p.application.type === "application" ? c.application : c.enquiry}{p.application.proposerRequired ? ` · ${c.proposer}` : ""}</p><p>{c.group}: {p.group} · {c.order}: {p.order}</p>{p.activeFrom && <p>{c.activeFrom}: {p.activeFrom}</p>}{p.activeTo && <p>{c.activeTo}: {p.activeTo}</p>}<p>{c.promotion}: {p.promotionId ? promotionNames[p.promotionId] ?? p.promotionId : c.noPromotion}</p><p>{copy.billingLabel}</p><p>{copy.badge}</p><p>{copy.audience}</p><p>{copy.summary}</p><p>{copy.description}</p><p>{copy.eligibility}</p><ul className="list-inside list-disc">{copy.benefits.map((b,i)=><li key={i}>{b}</li>)}</ul>{copy.documents.map(d=><p key={d.href}>{d.label}: {d.href}</p>)}<p>{copy.actionLabel}</p></article>;
  })}{page.sections.map(s=><section key={s.id}><h4>{s.title}</h4>{s.image&&<p>{s.image.alt}: {s.image.src}</p>}{s.paragraphs.map((p,i)=><p key={i}>{p}</p>)}<ul>{s.bullets.map((p,i)=><li key={i}>{p}</li>)}</ul>{s.documents.map(d=><p key={d.href}>{d.label}: {d.href}</p>)}</section>)}</div>;
}
