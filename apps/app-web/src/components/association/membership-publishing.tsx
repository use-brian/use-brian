"use client";
/** Draft -> human preview -> canonical publication. [COMP:app-web/association] */
import { useEffect, useRef, useState } from "react";
import type { MembershipCatalogueDocument, MembershipCatalogueDraft, WebsiteMembershipPlan, MembershipLocale, MembershipSite } from "@/lib/api/association";
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
import { FormFooter, InlineNotice, PageHeader, Segmented } from "./ui";
import { MembershipApplicationEditor, MembershipApplicationPreview } from "./membership-application-editor";
import { useAssociationDraftGuard } from "./workspace-ui";
import { associationLocalTime, associationInstant } from "./operator-controls";

const locales = ["en", "zh-Hant", "zh-Hans"] as const;
const emptyCopy = () => ({ name: "", summary: "", audience: "", badge: "", description: "", eligibility: "", benefits: [] as string[], actionLabel: "", billingLabel: "", documents: [] as {label:string;href:string}[] });
const copies = () => ({ en: emptyCopy(), "zh-Hant": emptyCopy(), "zh-Hans": emptyCopy() });
const emptyPage = () => ({ title: "", intro: "", groups: [{ id: "plans", title: "", intro: "" }], sections: [] as MembershipCatalogueDocument["pages"]["oasa"]["en"]["sections"] });
const pages = () => ({ en: emptyPage(), "zh-Hant": emptyPage(), "zh-Hans": emptyPage() });
function blank(): MembershipCatalogueDocument { return { schemaVersion: 1, plans: [], pages: { oasa: pages(), sea: pages() } }; }
const lines = (value: string) => value.split("\n");

function newPlan(document: MembershipCatalogueDocument, site: MembershipSite): WebsiteMembershipPlan {
  let number = document.plans.length + 1;
  while (document.plans.some(plan => plan.key === `plan-${number}`)) number++;
  return {
    key: `plan-${number}`, currency: "HKD", feeMinor: 0, billingPeriod: "annual",
    activeFrom: null, activeTo: null, availability: "closed",
    application: { type: "application", proposerRequired: false, codeOfConduct: true },
    sites: site ? [site] : [], group: document.pages[site]?.en.groups[0]?.id ?? "plans",
    order: document.plans.length, i18n: copies(), overrides: {}, promotionId: null,
  };
}

export function MembershipPublishingPanel({ workspaceId, initialPlan = "", initialNew = false }: { workspaceId: string; initialPlan?: string; initialNew?: boolean }) {
  const t = useT().associationPage, c = t.publishing, s = t.staff;
  const module = useAssociationModule(workspaceId), manage = !!module.data?.canManage && !module.error, commerceOn = module.data?.module.state === "enabled";
  const names = useWebsiteSiteNames(workspaceId, manage);
  const read = useCachedResource(manage ? associationPageCacheKey(workspaceId, "membership-catalogue") : null, () => getMembershipCatalogueDraft(workspaceId));
  const promotions = useAssociationPage(workspaceId, "promotions", {}, manage);
  const action = useAssociationAction(workspaceId);
  const [editing, setEditing] = useState<{version:number;document:MembershipCatalogueDocument}|null>(null);
  const [locale, setLocale] = useState<MembershipLocale>("en"), [wordingScope, setBrand] = useState<"shared"|MembershipSite|null>(null), [chosenSite, setSite] = useState<string>("");
  const [saved, setSaved] = useState<{ version: number; document: MembershipCatalogueDocument; issues: string[] } | null>(null);
  const [feeInput, setFeeInput] = useState<Record<string,string>>({});
  const [preview, setPreview] = useState(false), [selected, setSelected] = useState(0);
  const [editorTab, setEditorTab] = useState<"plan" | "form" | "page">("plan");
  const opened = useRef(false);
  const catalogue: MembershipCatalogueDraft | undefined = read.data && saved && saved.version > read.data.version ? { ...read.data, ...saved } : read.data;
  const baseline = saved?.version === editing?.version ? saved?.document : catalogue?.document;
  const invalidFee = Object.values(feeInput).some(value => !/^\d+(?:\.\d{1,2})?$/.test(value));
  const dirty = Boolean(editing && (invalidFee || JSON.stringify(editing.document) !== JSON.stringify(baseline)));
  const stale = Boolean(editing && catalogue && editing.version !== catalogue.version);
  useAssociationDraftGuard(dirty);
  const doc = editing?.document ?? read.data?.document;
  // Sites come from the catalogue document and the websites that read it, never from code.
  const sites = [...new Set([...Object.keys(doc?.pages ?? {}), ...Object.keys(read.data?.observations ?? {})])].sort() as MembershipSite[];
  const planSites = [...new Set(read.data?.document?.plans.flatMap(item => item.sites) ?? [])];
  const observedSite = sites.find(item => read.data?.observations[item]);
  const defaultSite = planSites.length === 1 ? planSites[0] : observedSite ?? sites[0];
  const plan = doc?.plans[selected];
  const planSite = plan?.sites.includes(defaultSite) ? defaultSite : plan?.sites[0];
  const site = (sites.includes(chosenSite as MembershipSite) ? chosenSite : planSite ?? defaultSite ?? "") as MembershipSite;
  const brand = wordingScope ?? (plan?.overrides[site] ? site : "shared");
  useEffect(() => {
    if (opened.current || !read.data || !manage || (!initialPlan && !initialNew)) return;
    opened.current = true;
    const document = structuredClone(read.data.document ?? blank());
    if (initialNew) {
      setSelected(document.plans.length);
      setBrand("shared");
      document.plans.push(newPlan(document, site || Object.keys(document.pages)[0] as MembershipSite));
      setEditing({ version: read.data.version, document });
    } else {
      const index = document.plans.findIndex(item => item.key === initialPlan);
      if (index < 0) return;
      setSelected(index);
      setEditing({ version: read.data.version, document });
    }
  }, [initialNew, initialPlan, manage, read.data, site]);

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
  const page = doc?.pages[site]?.[locale];
  const patchPage = (fn:(value:NonNullable<typeof page>)=>void) => patch(document => fn(document.pages[site][locale]));
  async function save() {
    if (!editing || !dirty || stale || invalidFee) return;
    const current = editing;
    await action.run(c.draft, async () => {
      const result = await saveMembershipCatalogueDraft(workspaceId, current.version, current.document);
      setSaved({ ...result, document: current.document });
      setEditing({ ...current, version: result.version });
      setFeeInput({});
      const fresh = await read.refresh();
      if (fresh?.version === result.version && fresh.document) {
        setSaved({ version: fresh.version, document: fresh.document, issues: fresh.issues });
        setEditing({ version: fresh.version, document: fresh.document });
      }
    }, false);
  }
  async function publish() {
    if (!catalogue || dirty || stale || !preview) return;
    const { version } = catalogue;
    if (await action.run(c.publish, () => publishMembershipCatalogue(workspaceId, version), { description: c.review })) {
      await read.refresh();
    }
  }
  return <section className="space-y-5">
    <PageHeader title={editing && plan && editorTab !== "page" ? copy?.name || plan.i18n.en.name || t.manage.newPlan : c.title} description={editing ? undefined : c.help} level={2}/>
    {!manage ? <InlineNotice tone="neutral">{t.ux.readOnly}</InlineNotice> : <AssociationListState {...read}>
      {read.data && <>
                <div className="flex flex-wrap gap-3" role="status">{read.data.publishedRevision > 0 ? Object.keys(read.data.observations).length === 0 ? <p className="text-sm">{t.content.statusNotRead}</p> : Object.keys(read.data.observations).map(s => <p key={s} className="text-sm">{format(read.data!.observations[s]?.revision === read.data!.publishedRevision ? t.content.observed : t.content.pending, { site: websiteSiteLabel(s, names) })}</p>) : null}</div>
        {!commerceOn && module.data ? <InlineNotice tone="neutral">{c.publishNeedsModule}</InlineNotice> : null}
        {!doc && <InlineNotice tone="neutral">{c.empty}</InlineNotice>}
        <div className="flex flex-wrap gap-2">
          {!editing && <Button className="max-sm:min-h-11" onClick={() => {setFeeInput({});setEditing({version:read.data!.version, document:structuredClone(doc ?? blank())});setEditorTab("plan");setPreview(false);}}>{doc ? c.edit : c.create}</Button>}
          {doc && <Button className="max-sm:min-h-11" variant="outline" aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? s.backToEditor : c.preview}</Button>}
          {preview && catalogue && <Button className="max-sm:min-h-11" disabled={!commerceOn || !!read.error || action.pending || dirty || stale || !!catalogue.issues?.length || catalogue.version === catalogue.publishedRevision} onClick={() => void publish()}>{c.publish}</Button>}
        </div>
        {action.feedback}
        {stale && <InlineNotice tone="warning">{s.catalogueChanged}</InlineNotice>}
        {preview && dirty && <InlineNotice tone="neutral">{s.saveBeforePublish}</InlineNotice>}
        {preview && !dirty && catalogue && catalogue.version !== catalogue.publishedRevision && <InlineNotice tone="neutral">{s.publishCatalogueScope}</InlineNotice>}
        {invalidFee && <InlineNotice tone="danger">{s.invalidPlanFee}</InlineNotice>}
        {!dirty && !!catalogue?.issues.length && <ul role="alert" className="list-inside list-disc text-sm text-destructive">{catalogue.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
        {doc && <div className="grid gap-3 md:grid-cols-3"><Choice label={c.locale} value={locale} values={locales} labels={{en:"English","zh-Hant":"繁體中文","zh-Hans":"简体中文"}} onChange={v=>setLocale(v as MembershipLocale)}/><Choice label={c.sites} value={site} values={sites} labels={Object.fromEntries(sites.map(key=>[key,websiteSiteLabel(key,names)]))} onChange={v=>{setSite(v as MembershipSite); setBrand(null);}}/></div>}
        {!editing && !preview && doc && <div className="grid gap-3 md:grid-cols-2">{doc.plans.map((p,i)=><article key={p.key} className="space-y-3 rounded-xl border p-4"><h3 className="font-semibold">{(p.overrides[site]?.[locale]?.name??p.i18n[locale].name)}</h3><p className="text-sm">{p.currency} {p.feeMinor/100} · {c[p.billingPeriod]}</p><p className="text-sm text-muted-foreground">{p.sites.map(s=>s.toUpperCase()).join(" · ")} · {p.availability==="enquiry"?c.enquiryStatus:c[p.availability]}</p><Button className="max-sm:min-h-11" variant="outline" disabled={module.data?.module.state!=="enabled"} onClick={()=>{setFeeInput({});setSelected(i);setEditorTab("plan");setEditing({version:read.data!.version,document:structuredClone(doc)});}}>{c.edit}</Button></article>)}</div>}
        {preview && doc && <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          {([c.before, c.after] as const).map((title, index) => <div className="min-w-0 space-y-4 rounded-xl border p-4" key={title}>
            <h3 className="font-semibold">{title}</h3>
            <CataloguePreview document={index === 0 ? read.data!.published : doc} locale={locale} site={site}
              planKey={editing && editorTab !== "page" ? plan?.key : undefined} showForm={editorTab === "form"}
              promotionNames={Object.fromEntries((promotions.data?.items ?? []).map(p => [p.id, p.name]))} />
          </div>)}
        </div>}
        {editing && doc && !preview && <fieldset disabled={action.pending} className="min-w-0 space-y-6">
          <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            {doc.plans.length > 0 && <Choice label={t.ux.plan} value={String(selected)} values={doc.plans.map((_, i) => String(i))}
              labels={Object.fromEntries(doc.plans.map((item, i) => [String(i), item.i18n[locale].name || item.i18n.en.name || t.manage.newPlan]))}
              onChange={value => { setSelected(Number(value)); setBrand(null); setSite(""); }} />}
            <Button className="min-h-11 md:min-h-9" variant="outline" onClick={() => {
              setSelected(doc.plans.length);
              setBrand("shared");
              setEditorTab("plan");
              patch(document => document.plans.push(newPlan(document, site)));
            }}>{t.manage.newPlan}</Button>
          </div>
          <Segmented label={t.ux.goTo} value={editorTab} onChange={setEditorTab} options={[
            { value: "plan", label: s.planDetails }, { value: "form", label: s.applicationForm }, { value: "page", label: s.pageWording },
          ]} />
          {editorTab === "form" && plan && <MembershipApplicationEditor key={plan.key} application={plan.application} free={plan.feeMinor===0} name={copy?.name || plan.i18n.en.name} onChange={value => setPlan("application", value)} />}
          {editorTab === "plan" && plan && copy && <section className="grid min-w-0 gap-4 rounded-xl border p-4 md:grid-cols-2">
            <Field label={c.name} value={copy.name} onChange={v=>patchCopy(value=>{value.name=v;})}/>
            <Field label={t.manage.fee} type="number" min={0} step="0.01" value={feeInput[plan.key] ?? String(plan.feeMinor/100)} onChange={v=>{setFeeInput(old=>({...old,[plan.key]:v}));if(/^\d+(?:\.\d{1,2})?$/.test(v))setPlan("feeMinor",Math.round(Number(v)*100));}}/>
            <Choice label={t.manage.billing} value={plan.billingPeriod} values={["annual","one_time","lifetime","manual"]} labels={{annual:c.annual,one_time:c.one_time,lifetime:c.lifetime,manual:c.manual}} onChange={v=>setPlan("billingPeriod",v as WebsiteMembershipPlan["billingPeriod"])}/>
            <Choice label={t.manage.status} value={plan.availability} values={["public","invitation","enquiry","closed"]} labels={{public:c.public,invitation:c.invitation,enquiry:c.enquiryStatus,closed:c.closed}} onChange={v=>setPlan("availability",v as WebsiteMembershipPlan["availability"])}/>
            <Choice label={c.wordingFor} value={brand} values={["shared",...sites]} labels={{shared:c.shared,...Object.fromEntries(sites.map(key=>[key,format(c.siteOverride,{site:websiteSiteLabel(key,names)} )]))}} onChange={value => { const next = value as typeof brand; setBrand(next); if (next !== "shared") setSite(next); }}/>
            {brand !== "shared" && <div className="flex items-end"><Button variant="outline" className="max-sm:min-h-11" onClick={()=>patch(d=>{delete d.plans[selected].overrides[brand]?.[locale];})}>{c.inherit}</Button></div>}
            <details className="min-w-0 rounded-lg bg-muted/30 px-3 pb-2 md:col-span-2">
              <summary className="min-h-11 md:min-h-9 cursor-pointer content-center text-sm font-medium">{t.ux.moreOptions}</summary>
              <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t.manage.key} value={plan.key} disabled={!!plan.planId} onChange={v=>setPlan("key",v)}/>
            <Field label={c.group} value={plan.group} onChange={v=>setPlan("group",v)}/><Field label={c.order} type="number" value={String(plan.order)} onChange={v=>setPlan("order",Number(v))}/>
            <Field label={c.activeFrom} type="datetime-local" value={associationLocalTime(plan.activeFrom)} onChange={v=>setPlan("activeFrom",associationInstant(v))}/><Field label={c.activeTo} type="datetime-local" value={associationLocalTime(plan.activeTo)} onChange={v=>setPlan("activeTo",associationInstant(v))}/>
            {sites.map(s=><Toggle key={s} label={`${c.sites}: ${websiteSiteLabel(s,names)}`} checked={plan.sites.includes(s)} onChange={v=>setPlan("sites",v?[...plan.sites,s]:plan.sites.filter(item=>item!==s))}/>)}
            <Choice label={c.promotion} value={plan.promotionId ?? "none"} values={["none",...(promotions.data?.items.filter(p=>p.targetKind==="plan"&&!!plan.planId&&p.targetIds.includes(plan.planId)).map(p=>p.id)??[])]} labels={{none:c.noPromotion,...Object.fromEntries((promotions.data?.items??[]).map(p=>[p.id,p.name]))}} onChange={v=>setPlan("promotionId",v==="none"?null:v)}/>
              </div>
            </details>
            {(["summary","audience","badge","description","eligibility","actionLabel","billingLabel"] as const).map(key=><Field key={key} label={c[key]} value={copy[key]} multiline={["summary","description","eligibility"].includes(key)} onChange={v=>patchCopy(value=>{value[key]=v;})}/>)}
            <Field label={c.benefits} multiline value={copy.benefits.join("\n")} onChange={v=>patchCopy(value=>{value.benefits=lines(v);})}/>
            <div className="space-y-3 md:col-span-2"><h4>{c.documents}</h4>{copy.documents.map((link,i)=><div className="grid gap-2 md:grid-cols-3" key={i}><Field label={c.name} value={link.label} onChange={v=>patchCopy(value=>{value.documents[i].label=v;})}/><Field label={c.url} value={link.href} onChange={v=>patchCopy(value=>{value.documents[i].href=v;})}/><Button variant="outline" className="max-sm:min-h-11" onClick={()=>patchCopy(value=>{value.documents.splice(i,1);})}>{c.remove}</Button></div>)}<Button variant="outline" className="max-sm:min-h-11" onClick={()=>patchCopy(value=>value.documents.push({label:"",href:"/"}))}>{c.add}</Button></div>
          </section>}
          {editorTab === "page" && page&&<section className="space-y-4 rounded-xl border p-4"><h3 className="font-semibold">{c.pages}: {site.toUpperCase()}</h3><Field label={c.titleField} value={page.title} onChange={v=>patchPage(p=>{p.title=v;})}/><Field label={c.intro} value={page.intro} multiline onChange={v=>patchPage(p=>{p.intro=v;})}/><p className="text-sm">{c.groupHelp}</p>
            {page.groups.map((group,i)=><div className="grid gap-2 md:grid-cols-3" key={i}><Field label={c.group} value={group.id} onChange={v=>patchPage(p=>{p.groups[i].id=v;})}/><Field label={c.titleField} value={group.title} onChange={v=>patchPage(p=>{p.groups[i].title=v;})}/><Field label={c.intro} value={group.intro} onChange={v=>patchPage(p=>{p.groups[i].intro=v;})}/><Button variant="outline" className="max-sm:min-h-11" onClick={()=>patchPage(p=>{p.groups.splice(i,1);})}>{c.remove}</Button></div>)}
            <Button variant="outline" className="max-sm:min-h-11" onClick={()=>patchPage(p=>p.groups.push({id:`group-${p.groups.length+1}`,title:"",intro:""}))}>{c.add}: {c.group}</Button>
            {page.sections.map((section,i)=><div className="space-y-3 border-t border-border pt-3" key={i}><Field label={c.titleField} value={section.title} onChange={v=>patchPage(p=>{p.sections[i].title=v;})}/><Field label={c.paragraphs} multiline value={section.paragraphs.join("\n")} onChange={v=>patchPage(p=>{p.sections[i].paragraphs=lines(v);})}/><Field label={c.bullets} multiline value={section.bullets.join("\n")} onChange={v=>patchPage(p=>{p.sections[i].bullets=lines(v);})}/>
              {section.image&&<><Field label={c.url} value={section.image.src} onChange={v=>patchPage(p=>{p.sections[i].image!.src=v;})}/><Field label={c.imageAlt} value={section.image.alt} onChange={v=>patchPage(p=>{p.sections[i].image!.alt=v;})}/></>}{section.documents.map((link,j)=><div className="grid gap-2 md:grid-cols-2" key={j}><Field label={c.name} value={link.label} onChange={v=>patchPage(p=>{p.sections[i].documents[j].label=v;})}/><Field label={c.url} value={link.href} onChange={v=>patchPage(p=>{p.sections[i].documents[j].href=v;})}/><Button variant="outline" className="max-sm:min-h-11" onClick={()=>patchPage(p=>{p.sections[i].documents.splice(j,1);})}>{c.remove}</Button></div>)}<Button variant="outline" className="max-sm:min-h-11" onClick={()=>patchPage(p=>p.sections[i].documents.push({label:"",href:"/"}))}>{c.add}: {c.documents}</Button><Button variant="outline" className="max-sm:min-h-11" onClick={()=>patchPage(p=>{p.sections.splice(i,1);})}>{c.remove}</Button></div>)}
            <Button variant="outline" className="max-sm:min-h-11" onClick={()=>patchPage(p=>p.sections.push({id:`section-${p.sections.length+1}`,title:"",paragraphs:[],bullets:[],documents:[]}))}>{c.addSection}</Button>
            {page.newsletter&&<div className="space-y-2"><h4>{c.newsletter}</h4>{(["name","summary","actionLabel"] as const).map(key=><Field key={key} label={c[key]} value={page.newsletter![key]} onChange={v=>patchPage(p=>{p.newsletter![key]=v;})}/>)}<Field label={c.benefits} multiline value={page.newsletter.benefits.join("\n")} onChange={v=>patchPage(p=>{p.newsletter!.benefits=lines(v);})}/></div>}
          </section>}
        </fieldset>}
        {editing && <FormFooter>
          <Button className="max-sm:min-h-11" disabled={action.pending || !dirty || !!read.error || invalidFee || stale} onClick={() => void save()}>{c.draft}</Button>
          <Button className="max-sm:min-h-11" variant="outline" onClick={async () => {
            if (!dirty || await confirmDialog({ title: t.ux.cancelEdit, description: t.ux.cancelHelp, confirmLabel: t.cancel, cancelLabel: t.ux.keepEditing })) {
              setEditing(null); setFeeInput({}); setPreview(false);
            }
          }}>{t.cancel}</Button>
        </FormFooter>}
      </>}
    </AssociationListState>}
  </section>;
}

function CataloguePreview({ document, site, locale, planKey, showForm, promotionNames = {} }: {
  document: MembershipCatalogueDocument | null;
  site: MembershipSite;
  locale: MembershipLocale;
  planKey?: string;
  showForm?: boolean;
  promotionNames?: Record<string, string>;
}) {
  const { publishing: c, staff: s } = useT().associationPage;
  const page = document?.pages[site]?.[locale];
  const plans = (document?.plans ?? []).filter(plan => plan.sites.includes(site) && (!planKey || plan.key === planKey)).sort((a, b) => a.order - b.order);
  if (!page || (planKey && !plans.length)) return <p className="text-sm text-muted-foreground">{s.noPlanPreview}</p>;
  return <div className="space-y-4 break-words">{!planKey && <><h4>{page.title}</h4><p>{page.intro}</p>{page.groups.map(group=><div key={group.id}><h4>{group.title}</h4><p>{group.intro}</p></div>)}</>}{plans.map(p=>{
    const copy={...p.i18n[locale],...p.overrides[site]?.[locale]};
    if (showForm) return <MembershipApplicationPreview key={p.key} application={p.application} name={copy.name} free={p.feeMinor === 0} />;
    return <article className="space-y-2 rounded-xl border p-3" key={p.key}><h4 className="font-semibold">{copy.name}</h4><p>{p.currency} {p.feeMinor/100} · {c[p.billingPeriod]} · {p.availability === "enquiry" ? c.enquiryStatus : c[p.availability]}</p><p>{c.type}: {p.application.type === "application" ? c.application : c.enquiry}{p.application.proposerRequired ? ` · ${c.proposer}` : ""}</p><p>{c.group}: {p.group} · {c.order}: {p.order}</p>{p.activeFrom && <p>{c.activeFrom}: {p.activeFrom}</p>}{p.activeTo && <p>{c.activeTo}: {p.activeTo}</p>}<p>{c.promotion}: {p.promotionId ? promotionNames[p.promotionId] ?? p.promotionId : c.noPromotion}</p><p>{copy.billingLabel}</p><p>{copy.badge}</p><p>{copy.audience}</p><p>{copy.summary}</p><p>{copy.description}</p><p>{copy.eligibility}</p><ul className="list-inside list-disc">{copy.benefits.map((b,i)=><li key={i}>{b}</li>)}</ul>{copy.documents.map(d=><p key={d.href}>{d.label}: {d.href}</p>)}<p>{copy.actionLabel}</p></article>;
  })}{!planKey && page.sections.map(s=><section key={s.id}><h4>{s.title}</h4>{s.image&&<p>{s.image.alt}: {s.image.src}</p>}{s.paragraphs.map((p,i)=><p key={i}>{p}</p>)}<ul>{s.bullets.map((p,i)=><li key={i}>{p}</li>)}</ul>{s.documents.map(d=><p key={d.href}>{d.label}: {d.href}</p>)}</section>)}</div>;
}
