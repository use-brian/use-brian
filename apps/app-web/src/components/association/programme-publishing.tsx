"use client";
/** Website programme content: draft -> human preview -> immutable publication. Content only, no prices. [COMP:app-web/association] */
import { useState } from "react";
import type { ProgrammeCatalogueDocument, WebsiteProgramme, ProgrammeCopy, ProgrammeAudience, ProgrammeSection, ProgrammeSubsection, MembershipLocale, MembershipSite } from "@/lib/api/association";
import { PROGRAMME_AUDIENCES, PROGRAMME_GALLERIES, getProgrammeCatalogueDraft, saveProgrammeCatalogueDraft, publishProgrammeCatalogue, websiteSiteLabel } from "@/lib/api/association";
import { format } from "@/lib/i18n/format";
import { useWebsiteSiteNames } from "./website/website-status";
import { useT } from "@/lib/i18n/client";
import { useCachedResource } from "@/lib/surface-cache";
import { associationPageCacheKey } from "@/lib/surface-prefetch";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { AssociationField as Field, AssociationChoice as Choice, AssociationToggle as Toggle, AssociationListState, useAssociationAction } from "./operator-controls";
import { useAssociationModule } from "./module-controls";
import { InlineNotice, PageHeader } from "./ui";
import { MediaChoice } from "./site-content/document-editor";
import { listWebsiteMedia } from "@/lib/api/association";

const locales = ["en", "zh-Hant", "zh-Hans"] as const;
const emptyCopy = (): ProgrammeCopy => ({ name: "", tagline: "", kicker: "", summary: "", audienceBlurbs: {}, sections: [], facts: [], steps: null, feeUnit: "", feeNotes: [], eligibility: [], contacts: [], links: [], cta: null });
const emptySub = (index: number): ProgrammeSubsection => ({ id: `part-${index}`, heading: "", paragraphs: [], bullets: [], numbered: [] });
const emptySection = (index: number): ProgrammeSection => ({ ...emptySub(index), id: `section-${index}`, subsections: [] });
function blank(): ProgrammeCatalogueDocument { return { schemaVersion: 1, audiences: { corporates: { gallery: "spacebiz-dialogues", order: [] }, schools: { gallery: "space-exchange-tour", order: [] }, students: { gallery: "young-marco-polo", order: [] } }, programmes: [] }; }
const lines = (value: string) => value.split("\n");
const money = /^\d+(?:\.\d{1,2})?$/;

export function ProgrammePublishingPanel({ workspaceId }: { workspaceId: string }) {
  const t = useT().associationPage, c = t.programmes;
  const module = useAssociationModule(workspaceId), manage = !!module.data?.canManage;
  const names = useWebsiteSiteNames(workspaceId, manage);
  const read = useCachedResource(manage ? associationPageCacheKey(workspaceId, "programme-catalogue") : null, () => getProgrammeCatalogueDraft(workspaceId));
  const action = useAssociationAction(workspaceId);
  const media = useCachedResource(manage ? associationPageCacheKey(workspaceId, "website-media") : null, () => listWebsiteMedia(workspaceId));
  const [editing, setEditing] = useState<{ version: number; document: ProgrammeCatalogueDocument } | null>(null);
  const [locale, setLocale] = useState<MembershipLocale>("en"), [chosenSite, setSite] = useState<string>("");
  const [feeInput, setFeeInput] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState(false), [selected, setSelected] = useState(0);
  const doc = editing?.document ?? read.data?.document;
  // Sites come from data: websites that read programmes, sites already chosen, and sites with published settings. Never from code.
  const sites = [...new Set([...Object.keys(read.data?.observations ?? {}), ...(doc?.programmes ?? []).flatMap(p => p.sites), ...Object.keys(names)])].sort() as MembershipSite[];
  const site = (sites.includes(chosenSite as MembershipSite) ? chosenSite : sites[0] ?? "") as MembershipSite;
  const programme = doc?.programmes[selected];
  const publishedSlugs = new Set((read.data?.published?.programmes ?? []).map(p => p.slug));
  const patch = (fn: (document: ProgrammeCatalogueDocument) => void) => setEditing(old => { if (!old) return old; const next = structuredClone(old); fn(next.document); return next; });
  const setProgramme = <K extends keyof WebsiteProgramme>(key: K, value: WebsiteProgramme[K]) => patch(document => { document.programmes[selected][key] = value; });
  const copy = programme?.i18n[locale];
  const patchCopy = (fn: (value: ProgrammeCopy) => void) => patch(document => { const value = document.programmes[selected].i18n[locale]; if (value) fn(value); });
  const statusLabel = (status: WebsiteProgramme["status"]) => status === "live" ? c.live : status === "coming-soon" ? c.comingSoon : c.retired;
  async function save() { if (!editing) return; const current = editing; if (await action.run(c.draft, () => saveProgrammeCatalogueDraft(workspaceId, current.version, current.document), false)) { setEditing(null); setFeeInput({}); setPreview(false); await read.refresh(); } }
  async function publish() { if (!read.data || editing || !preview) return; if (await action.run(c.publish, () => publishProgrammeCatalogue(workspaceId, read.data!.version), false)) { setPreview(false); await read.refresh(); } }
  const startEditing = (index = selected) => { setFeeInput({}); setSelected(index); setEditing({ version: read.data!.version, document: structuredClone(doc ?? blank()) }); setPreview(false); };
  return <section className="space-y-5">
    <PageHeader title={c.title} description={c.help}/>
    {!manage ? <InlineNotice tone="neutral">{t.ux.readOnly}</InlineNotice> : <AssociationListState {...read}>
      {read.data && <>
        <p className="text-sm">{c.published}: {read.data.publishedRevision}</p>
        <div className="flex flex-wrap gap-3" role="status">{Object.keys(read.data.observations).length === 0 && read.data.publishedRevision > 0 ? <p className="text-sm">{t.content.statusNotRead}</p> : null}{Object.keys(read.data.observations).map(s => <p key={s} className="text-sm">{format(read.data!.observations[s]?.revision === read.data!.publishedRevision ? t.content.observed : t.content.pending, { site: websiteSiteLabel(s, names) })}</p>)}</div>
        {!doc && <InlineNotice tone="neutral">{c.empty}</InlineNotice>}
        <div className="flex flex-wrap gap-2">
          {!editing && <Button className="min-h-11" onClick={() => startEditing(0)}>{doc ? c.edit : c.create}</Button>}
          {editing && <><Button className="min-h-11" disabled={action.pending || Object.values(feeInput).some(value => value !== "" && !money.test(value))} onClick={() => void save()}>{c.draft}</Button><Button className="min-h-11" variant="outline" onClick={async () => { if (await confirmDialog({ title: t.ux.cancelEdit, description: t.ux.cancelHelp, confirmLabel: t.cancel, cancelLabel: t.ux.keepEditing })) { setEditing(null); setFeeInput({}); } }}>{t.cancel}</Button></>}
          {!editing && doc && <Button className="min-h-11" variant="outline" onClick={() => setPreview(!preview)}>{c.preview}</Button>}
          {preview && !editing && <Button className="min-h-11" disabled={!!read.error || action.pending || !!read.data.issues.length || read.data.version === read.data.publishedRevision} onClick={() => void publish()}>{c.publish}</Button>}
        </div>
        {action.feedback}{read.data.issues.length > 0 && <ul role="alert" className="list-inside list-disc text-sm text-destructive">{read.data.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
        {doc && <div className="grid gap-3 md:grid-cols-3"><Choice label={c.locale} value={locale} values={locales} labels={{ en: "English", "zh-Hant": "繁體中文", "zh-Hans": "简体中文" }} onChange={v => setLocale(v as MembershipLocale)}/>{sites.length > 1 ? <Choice label={c.site} value={site} values={sites} labels={Object.fromEntries(sites.map(key => [key, websiteSiteLabel(key, names)]))} onChange={v => setSite(v)}/> : null}</div>}
        {!editing && !preview && doc && <div className="grid gap-3 md:grid-cols-2">{doc.programmes.map((p, i) => <article key={p.slug} className="space-y-2 rounded-xl border p-4"><h3 className="font-semibold">{(p.i18n[locale] ?? p.i18n.en).name}</h3><p className="text-sm text-muted-foreground">{statusLabel(p.status)} · {p.audiences.map(a => c[a]).join(" · ")}{p.fee ? ` · HKD ${p.fee.amountMinor / 100}` : ""}</p><Button className="min-h-11" variant="outline" onClick={() => startEditing(i)}>{c.edit}</Button></article>)}</div>}
        {preview && doc && <div className="grid min-w-0 gap-4 lg:grid-cols-2">{([c.before, c.after] as const).map((title, index) => <div className="min-w-0 rounded-xl border p-4" key={title}><h3 className="font-semibold">{title}</h3><ProgrammePreview document={index === 0 ? read.data!.published : doc} locale={locale} site={site}/></div>)}</div>}
        {editing && doc && <fieldset disabled={action.pending} className="min-w-0 space-y-6">
          <div className="flex flex-wrap gap-2">{doc.programmes.map((p, i) => <Button className="min-h-11 max-w-full" key={i} variant={i === selected ? "default" : "outline"} onClick={() => setSelected(i)}>{(p.i18n[locale] ?? p.i18n.en).name || p.slug || c.newProgramme}</Button>)}
            <Button className="min-h-11" variant="outline" onClick={() => { setSelected(doc.programmes.length); patch(d => d.programmes.push({ slug: `programme-${d.programmes.length + 1}`, audiences: ["students"], order: d.programmes.length, sites: sites.slice(0, 1), status: "live", fee: null, gallery: null, cover: null, href: null, i18n: { en: emptyCopy() } })); }}>{c.newProgramme}</Button>
          </div>
          {programme && <section className="grid min-w-0 gap-4 rounded-xl border p-4 md:grid-cols-2">
            <Field label={c.slug} value={programme.slug} disabled={publishedSlugs.has(programme.slug)} help={publishedSlugs.has(programme.slug) ? c.slugLocked : undefined} onChange={v => setProgramme("slug", v)}/>
            <Choice label={c.status} value={programme.status} values={["live", "coming-soon", "retired"]} labels={{ live: c.live, "coming-soon": c.comingSoon, retired: c.retired }} onChange={v => setProgramme("status", v as WebsiteProgramme["status"])}/>
            <Field label={c.order} type="number" min={0} value={String(programme.order)} onChange={v => setProgramme("order", Number(v))}/>
            <Field label={c.fee} type="number" min={0} step="0.01" value={feeInput[programme.slug] ?? (programme.fee ? String(programme.fee.amountMinor / 100) : "")} help={c.noFee} onChange={v => { setFeeInput(old => ({ ...old, [programme.slug]: v })); if (v === "") setProgramme("fee", null); else if (money.test(v)) setProgramme("fee", { currency: "HKD", amountMinor: Math.round(Number(v) * 100) }); }}/>
            {PROGRAMME_AUDIENCES.map(a => <Toggle key={a} label={`${c.audiences}: ${c[a]}`} checked={programme.audiences.includes(a)} onChange={v => setProgramme("audiences", v ? [...programme.audiences, a] : programme.audiences.filter(item => item !== a))}/>)}
            {sites.map(s => <Toggle key={s} label={`${c.sites}: ${websiteSiteLabel(s, names)}`} checked={programme.sites.includes(s)} onChange={v => setProgramme("sites", v ? [...programme.sites, s] : programme.sites.filter(item => item !== s))}/>)}
            <Choice label={c.gallery} value={programme.gallery ?? "none"} values={["none", ...PROGRAMME_GALLERIES]} labels={{ none: c.noGallery }} onChange={v => setProgramme("gallery", v === "none" ? null : v as WebsiteProgramme["gallery"])}/>
            <div className="space-y-2 md:col-span-2">
              <MediaChoice label={c.coverLibrary} value={programme.coverMediaId ?? undefined} context={{ locale, media: media.data ?? [], workspaceId, sites, siteNames: names }} images
                onChange={id => patch(d => { const p = d.programmes[selected]; p.coverMediaId = id ?? null; if (id) p.cover = null; })}/>
              <p className="text-xs text-muted-foreground">{c.coverLibraryHelp}</p>
            </div>
            {!programme.coverMediaId && <Field label={c.cover} value={programme.cover ?? ""} onChange={v => setProgramme("cover", v || null)}/>}
            {programme.coverMediaId && copy && <Field label={c.coverAlt} value={copy.coverAlt ?? ""} help={locale === "en" ? c.coverAltHelp : undefined} onChange={v => patchCopy(value => { value.coverAlt = v; })}/>}
            <Field label={c.href} value={programme.href ?? ""} onChange={v => setProgramme("href", v || null)}/>
            {!copy && <div className="space-y-2 md:col-span-2"><InlineNotice tone="neutral">{c.noTranslation}</InlineNotice><Button variant="outline" className="min-h-11" onClick={() => patch(d => { d.programmes[selected].i18n[locale] = { ...structuredClone(d.programmes[selected].i18n.en) }; })}>{c.addTranslation}</Button></div>}
            {copy && locale !== "en" && <Button variant="outline" className="min-h-11 md:col-span-2" onClick={() => patch(d => { delete d.programmes[selected].i18n[locale]; })}>{c.removeTranslation}</Button>}
            {copy && <>
              {(["name", "tagline", "kicker", "summary", "feeUnit"] as const).map(key => <Field key={key} label={c[key]} value={copy[key]} multiline={key === "summary"} onChange={v => patchCopy(value => { value[key] = v; })}/>)}
              <Field label={c.feeNotes} multiline value={copy.feeNotes.join("\n")} onChange={v => patchCopy(value => { value.feeNotes = v ? lines(v) : []; })}/>
              {programme.audiences.map(a => <Field key={a} label={`${c.audienceBlurb}: ${c[a]}`} multiline value={copy.audienceBlurbs[a] ?? ""} onChange={v => patchCopy(value => { if (v) value.audienceBlurbs[a] = v; else delete value.audienceBlurbs[a]; })}/>)}
              <Rows title={c.facts} rows={copy.facts} fields={[["value", c.factValue], ["label", c.factLabel]]} add={c.add} remove={c.remove} blankRow={() => ({ value: "", label: "" })} onChange={rows => patchCopy(value => { value.facts = rows; })}/>
              <Rows title={c.eligibility} rows={copy.eligibility} fields={[["label", c.eligibilityLabel], ["value", c.eligibilityValue]]} add={c.add} remove={c.remove} blankRow={() => ({ label: "", value: "" })} onChange={rows => patchCopy(value => { value.eligibility = rows; })}/>
              <Rows title={c.contacts} rows={copy.contacts.map(row => ({ label: row.label, name: row.name ?? "", email: row.email }))} fields={[["label", c.contactLabel], ["name", c.contactName], ["email", c.contactEmail]]} add={c.add} remove={c.remove} blankRow={() => ({ label: "", name: "", email: "" })} onChange={rows => patchCopy(value => { value.contacts = rows.map(row => ({ label: row.label, email: row.email, ...(row.name ? { name: row.name } : {}) })); })}/>
              <Rows title={c.links} rows={copy.links} fields={[["label", c.linkLabel], ["href", c.linkUrl]]} add={c.add} remove={c.remove} blankRow={() => ({ label: "", href: "/" })} onChange={rows => patchCopy(value => { value.links = rows; })}/>
              <div className="space-y-3 md:col-span-2"><h4>{c.cta}</h4>
                {!copy.cta ? <Button variant="outline" className="min-h-11" onClick={() => patchCopy(value => { value.cta = { heading: "", text: "", href: "/contact", label: "" }; })}>{c.add}: {c.cta}</Button> : <div className="grid gap-2 md:grid-cols-2">
                  {(["heading", "text", "href", "label"] as const).map(key => <Field key={key} label={c[key === "heading" ? "ctaHeading" : key === "text" ? "ctaText" : key === "href" ? "linkUrl" : "ctaLabel"]} value={copy.cta![key]} onChange={v => patchCopy(value => { value.cta![key] = v; })}/>)}
                  <Field label={`${c.ctaSecondary}: ${c.linkLabel}`} value={copy.cta.secondary?.label ?? ""} onChange={v => patchCopy(value => { value.cta!.secondary = v || value.cta!.secondary?.href ? { label: v, href: value.cta!.secondary?.href ?? "/" } : undefined; })}/>
                  <Field label={`${c.ctaSecondary}: ${c.linkUrl}`} value={copy.cta.secondary?.href ?? ""} onChange={v => patchCopy(value => { value.cta!.secondary = v || value.cta!.secondary?.label ? { label: value.cta!.secondary?.label ?? "", href: v } : undefined; })}/>
                  <Button variant="outline" className="min-h-11" onClick={() => patchCopy(value => { value.cta = null; })}>{c.remove}: {c.cta}</Button></div>}
              </div>
              <div className="space-y-3 md:col-span-2"><h4>{c.steps}</h4>
                {!copy.steps ? <Button variant="outline" className="min-h-11" onClick={() => patchCopy(value => { value.steps = { title: "", items: [] }; })}>{c.add}: {c.steps}</Button> : <div className="space-y-2">
                  <Field label={c.stepsTitle} value={copy.steps.title} onChange={v => patchCopy(value => { value.steps!.title = v; })}/>
                  <Rows title="" rows={copy.steps.items} fields={[["title", c.stepTitle], ["text", c.stepText]]} add={c.add} remove={c.remove} blankRow={() => ({ title: "", text: "" })} onChange={rows => patchCopy(value => { value.steps!.items = rows; })}/>
                  <Button variant="outline" className="min-h-11" onClick={() => patchCopy(value => { value.steps = null; })}>{c.remove}: {c.steps}</Button></div>}
              </div>
              <div className="space-y-3 md:col-span-2"><h4>{c.sections}</h4>
                {copy.sections.map((section, i) => <div className="space-y-3 rounded-xl border p-3" key={i}>
                  <SectionFields section={section} labels={c} onChange={fn => patchCopy(value => fn(value.sections[i]))}/>
                  <div className="space-y-2 pl-3"><h5 className="text-sm font-medium">{c.subsections}</h5>
                    {section.subsections.map((sub, j) => <div className="space-y-2 rounded-lg border p-2" key={j}><SectionFields section={sub} labels={c} onChange={fn => patchCopy(value => fn(value.sections[i].subsections[j]))}/><Button variant="outline" className="min-h-11" onClick={() => patchCopy(value => { value.sections[i].subsections.splice(j, 1); })}>{c.remove}</Button></div>)}
                    <Button variant="outline" className="min-h-11" onClick={() => patchCopy(value => { value.sections[i].subsections.push(emptySub(value.sections[i].subsections.length + 1)); })}>{c.add}: {c.subsections}</Button></div>
                  <Button variant="outline" className="min-h-11" onClick={() => patchCopy(value => { value.sections.splice(i, 1); })}>{c.remove}: {c.sections}</Button>
                </div>)}
                <Button variant="outline" className="min-h-11" onClick={() => patchCopy(value => { value.sections.push(emptySection(value.sections.length + 1)); })}>{c.add}: {c.sections}</Button>
              </div>
            </>}
          </section>}
          <section className="space-y-3 rounded-xl border p-4"><h3 className="font-semibold">{c.audienceOrder}</h3><p className="text-sm">{c.audienceOrderHelp}</p>
            {PROGRAMME_AUDIENCES.map(a => <div className="grid gap-2 md:grid-cols-2" key={a}><Choice label={`${c[a]}: ${c.gallery}`} value={doc.audiences[a].gallery} values={PROGRAMME_GALLERIES} onChange={v => patch(d => { d.audiences[a].gallery = v as ProgrammeCatalogueDocument["audiences"]["corporates"]["gallery"]; })}/><Field label={`${c[a]}: ${c.order}`} multiline value={doc.audiences[a].order.join("\n")} onChange={v => patch(d => { d.audiences[a].order = v ? lines(v) : []; })}/></div>)}
          </section>
        </fieldset>}
      </>}
    </AssociationListState>}
  </section>;
}

function SectionFields({ section, labels: c, onChange }: { section: ProgrammeSubsection; labels: { sectionId: string; heading: string; paragraphs: string; bullets: string; numbered: string; quoteText: string; quoteCite: string }; onChange: (fn: (value: ProgrammeSubsection) => void) => void }) {
  return <div className="grid gap-2 md:grid-cols-2">
    <Field label={c.sectionId} value={section.id} onChange={v => onChange(value => { value.id = v; })}/><Field label={c.heading} value={section.heading} onChange={v => onChange(value => { value.heading = v; })}/>
    <Field label={c.paragraphs} multiline value={section.paragraphs.join("\n")} onChange={v => onChange(value => { value.paragraphs = v ? lines(v) : []; })}/>
    <Field label={c.bullets} multiline value={section.bullets.join("\n")} onChange={v => onChange(value => { value.bullets = v ? lines(v) : []; })}/>
    <Field label={c.numbered} multiline value={section.numbered.join("\n")} onChange={v => onChange(value => { value.numbered = v ? lines(v) : []; })}/>
    <Field label={c.quoteText} value={section.quote?.text ?? ""} onChange={v => onChange(value => { value.quote = v || value.quote?.cite ? { text: v, cite: value.quote?.cite ?? "" } : undefined; })}/>
    <Field label={c.quoteCite} value={section.quote?.cite ?? ""} onChange={v => onChange(value => { value.quote = v || value.quote?.text ? { text: value.quote?.text ?? "", cite: v } : undefined; })}/>
  </div>;
}

function Rows<Row extends Record<string, string>>({ title, rows, fields, add, remove, blankRow, onChange }: { title: string; rows: Row[]; fields: [keyof Row & string, string][]; add: string; remove: string; blankRow: () => Row; onChange: (rows: Row[]) => void }) {
  return <div className="space-y-3 md:col-span-2">{title && <h4>{title}</h4>}
    {rows.map((row, i) => <div className="grid gap-2 md:grid-cols-4" key={i}>{fields.map(([key, label]) => <Field key={key} label={label} value={row[key]} onChange={v => { const next = rows.map(r => ({ ...r })); next[i][key] = v as Row[typeof key]; onChange(next); }}/>)}<Button variant="outline" className="min-h-11" onClick={() => onChange(rows.filter((_, j) => j !== i))}>{remove}</Button></div>)}
    <Button variant="outline" className="min-h-11" onClick={() => onChange([...rows, blankRow()])}>{add}{title ? `: ${title}` : ""}</Button>
  </div>;
}

function ProgrammePreview({ document, site, locale }: { document: ProgrammeCatalogueDocument | null; site: MembershipSite; locale: MembershipLocale }) {
  const c = useT().associationPage.programmes;
  if (!document) return null;
  const programmes = document.programmes.filter(p => p.sites.includes(site) && p.status !== "retired").sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
  return <div className="space-y-4 break-words">
    {PROGRAMME_AUDIENCES.map(a => <p key={a} className="text-sm text-muted-foreground">{c[a]}: {document.audiences[a].gallery} · {document.audiences[a].order.join(", ")}</p>)}
    {programmes.map(p => { const copy = p.i18n[locale] ?? p.i18n.en; const lang = p.i18n[locale] ? locale : "en";
      return <article className="space-y-2 rounded-xl border p-3" key={p.slug} lang={lang}><h4 className="font-semibold">{copy.name}</h4><p className="text-sm text-muted-foreground">{p.slug} · {p.status === "live" ? c.live : p.status === "coming-soon" ? c.comingSoon : c.retired} · {p.audiences.map(a => c[a]).join(", ")}{p.href ? ` · ${p.href}` : ""}{p.gallery ? ` · ${p.gallery}` : ""}</p>
        <p>{copy.kicker} · {copy.tagline}</p><p>{copy.summary}</p>{p.fee && <p>HKD {p.fee.amountMinor / 100} {copy.feeUnit}</p>}{copy.feeNotes.map((note, i) => <p key={i} className="text-sm">{note}</p>)}
        {copy.facts.length > 0 && <ul className="list-inside list-disc">{copy.facts.map((fact, i) => <li key={i}>{fact.value}: {fact.label}</li>)}</ul>}
        {copy.sections.map(section => <section key={section.id}><h5 className="font-medium">{section.heading}</h5>{section.paragraphs.map((text, i) => <p key={i}>{text}</p>)}{section.bullets.length > 0 && <ul className="list-inside list-disc">{section.bullets.map((text, i) => <li key={i}>{text}</li>)}</ul>}{section.numbered.length > 0 && <ol className="list-inside list-decimal">{section.numbered.map((text, i) => <li key={i}>{text}</li>)}</ol>}{section.quote && <blockquote>{section.quote.text} — {section.quote.cite}</blockquote>}
          {section.subsections.map(sub => <div key={sub.id} className="pl-3"><h6 className="font-medium">{sub.heading}</h6>{sub.paragraphs.map((text, i) => <p key={i}>{text}</p>)}{sub.bullets.length > 0 && <ul className="list-inside list-disc">{sub.bullets.map((text, i) => <li key={i}>{text}</li>)}</ul>}{sub.numbered.length > 0 && <ol className="list-inside list-decimal">{sub.numbered.map((text, i) => <li key={i}>{text}</li>)}</ol>}</div>)}</section>)}
        {copy.eligibility.map((rule, i) => <p key={i}>{rule.label}: {rule.value}</p>)}{copy.steps && <div><h5 className="font-medium">{copy.steps.title}</h5><ol className="list-inside list-decimal">{copy.steps.items.map((step, i) => <li key={i}>{step.title}: {step.text}</li>)}</ol></div>}
        {copy.contacts.map((contact, i) => <p key={i}>{contact.label}: {contact.name ? `${contact.name} · ` : ""}{contact.email}</p>)}{copy.links.map(link => <p key={link.href}>{link.label}: {link.href}</p>)}
        {copy.cta && <p>{copy.cta.heading} · {copy.cta.label} ({copy.cta.href}){copy.cta.secondary ? ` · ${copy.cta.secondary.label} (${copy.cta.secondary.href})` : ""}</p>}
      </article>; })}
  </div>;
}
