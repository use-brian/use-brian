"use client";
/** Event → Page: build the public event page like a site builder — cover, summary and sections you drag into order —
 * with the real website rendering the draft beside you as you type. Stored in the `event-pages` website collection
 * (draft → publish); the event row (dates, venue, tickets) stays in the event itself. [COMP:app-web/association] */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, ChevronDown, Eye, EyeOff, GripVertical, Images, ListOrdered, Mic, MessageCircleQuestion, Monitor, Plus, Smartphone, Trash2, Type, Handshake, Image as ImageIcon, type LucideIcon } from "lucide-react";
import {
  EVENT_SECTION_KINDS, getSiteContentDraft, listWebsiteMedia, publishSiteContent, saveSiteContentDraft, websiteSiteLabel,
  type AssociationEvent, type EventPageContent, type EventPagesDocument, type EventSection, type EventSectionKind, type LocalizedCopy, type MembershipLocale, type WebsiteImage,
} from "@/lib/api/association";
import { format } from "@/lib/i18n/format";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { useCachedResource } from "@/lib/surface-cache";
import { associationPageCacheKey } from "@/lib/surface-prefetch";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AssociationChoice, AssociationField, AssociationListState, useAssociationAction } from "../operator-controls";
import { InlineNotice, Segmented, StatusPill } from "../ui";
import { useWebsiteSiteNames } from "../website/website-status";
import { ImagePicker } from "./image-picker";

const LOCALES = ["en", "zh-Hant", "zh-Hans"] as const;
const LOCALE_LABELS = { en: "English", "zh-Hant": "繁體中文", "zh-Hans": "简体中文" };
const KIND_ICONS: Record<EventSectionKind, LucideIcon> = { text: Type, image: ImageIcon, gallery: Images, speakers: Mic, partners: Handshake, agenda: ListOrdered, faq: MessageCircleQuestion };
const PREVIEW_MESSAGE = "brian:event-preview";

type Ctx = { locale: MembershipLocale; workspaceId: string; media: Parameters<typeof ImagePicker>[0]["media"]; onUploaded: () => void };
const read = (value: LocalizedCopy | undefined, locale: MembershipLocale) => value?.[locale] ?? "";
/** Write one language; English is the required base, an empty translation falls back to English. */
function write(value: LocalizedCopy | undefined, locale: MembershipLocale, text: string): LocalizedCopy {
  const base = value ?? { en: "" };
  return locale === "en" ? { ...base, en: text } : { ...base, [locale]: text || undefined };
}
/** Same content regardless of key order (stored drafts come back with the database's key order). */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const optional = (value: LocalizedCopy | undefined) => value && (value.en || value["zh-Hant"] || value["zh-Hans"]) ? value : undefined;

function blankSection(kind: EventSectionKind, taken: readonly string[]): EventSection {
  let n = 1; while (taken.includes(`${kind}-${n}`)) n += 1;
  const id = `${kind}-${n}`, base = { id, hidden: false };
  switch (kind) {
    case "text": return { ...base, kind, body: { en: "" } };
    case "image": return { ...base, kind, image: { alt: { en: "" } } };
    case "gallery": return { ...base, kind, images: [] };
    case "speakers": return { ...base, kind, people: [{ name: "" }] };
    case "partners": return { ...base, kind, partners: [{ name: "" }] };
    case "agenda": return { ...base, kind, items: [{ time: "", title: { en: "" } }] };
    case "faq": return { ...base, kind, items: [{ question: { en: "" }, answer: { en: "" } }] };
  }
}

function Text({ label, value, onChange, locale, multiline = false, help }: { label: string; value: LocalizedCopy | undefined; onChange: (next: LocalizedCopy) => void; locale: MembershipLocale; multiline?: boolean; help?: string }) {
  return <AssociationField label={label} value={read(value, locale)} multiline={multiline} help={help} placeholder={locale !== "en" ? value?.en : undefined} onChange={text => onChange(write(value, locale, text))} />;
}

/** A small repeatable list (speakers, agenda items…): add, remove and move entries. */
function Rows<T>({ items, onChange, blank, render, addLabel }: { items: T[]; onChange: (next: T[]) => void; blank: () => NoInfer<T>; render: (item: NoInfer<T>, set: (next: NoInfer<T>) => void) => ReactNode; addLabel: string }) {
  const e = useT().associationPage.eventPage;
  const move = (from: number, to: number) => onChange(arrayMove(items, from, to));
  return <div className="space-y-3">
    {items.map((item, index) => <div key={index} className="space-y-3 rounded-xl border border-border p-3">
      {render(item, next => onChange(items.map((old, i) => i === index ? next : old)))}
      <div className="flex flex-wrap gap-1">
        <Button type="button" size="sm" variant="ghost" className="min-h-11 md:min-h-8" aria-label={e.moveUp} disabled={index === 0} onClick={() => move(index, index - 1)}><ArrowUp aria-hidden className="size-4" /></Button>
        <Button type="button" size="sm" variant="ghost" className="min-h-11 md:min-h-8" aria-label={e.moveDown} disabled={index === items.length - 1} onClick={() => move(index, index + 1)}><ArrowDown aria-hidden className="size-4" /></Button>
        <Button type="button" size="sm" variant="ghost" className="min-h-11 text-destructive md:min-h-8" onClick={() => onChange(items.filter((_, i) => i !== index))}><Trash2 aria-hidden className="size-4" />{e.remove}</Button>
      </div>
    </div>)}
    <Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-8" onClick={() => onChange([...items, blank()])}><Plus aria-hidden className="size-4" />{addLabel}</Button>
  </div>;
}

function SectionFields({ section, onChange, ctx }: { section: EventSection; onChange: (next: EventSection) => void; ctx: Ctx }) {
  const e = useT().associationPage.eventPage, { locale } = ctx;
  const picker = (label: string, value: WebsiteImage | undefined, set: (next: WebsiteImage | undefined) => void, compact = false) =>
    <ImagePicker workspaceId={ctx.workspaceId} label={label} value={value} onChange={set} media={ctx.media} onUploaded={ctx.onUploaded} locale={locale} compact={compact} />;
  const heading = "heading" in section || section.kind !== "image"
    ? <Text label={e.sectionHeading} value={"heading" in section ? section.heading : undefined} locale={locale} onChange={next => onChange({ ...section, heading: optional(next) } as EventSection)} /> : null;
  switch (section.kind) {
    case "text": return <>{heading}<Text label={e.body} value={section.body} locale={locale} multiline help={e.bodyHelp} onChange={body => onChange({ ...section, body })} /></>;
    case "image": return <>{picker(e.image, section.image, image => image && onChange({ ...section, image }))}
      <Text label={e.caption} value={section.caption} locale={locale} onChange={caption => onChange({ ...section, caption: optional(caption) })} /></>;
    case "gallery": return <>{heading}<Rows items={section.images} addLabel={e.addPhoto} blank={() => ({ alt: { en: "" } })} onChange={images => onChange({ ...section, images })}
      render={(image, set) => picker(e.photo, image.mediaId || image.src ? image : undefined, next => set(next ?? { alt: { en: "" } }), true)} /></>;
    case "speakers": return <>{heading}<Rows items={section.people} addLabel={e.addSpeaker} blank={() => ({ name: "" })} onChange={people => onChange({ ...section, people })}
      render={(person, set) => <>
        <AssociationField label={e.name} value={person.name} onChange={name => set({ ...person, name })} />
        <Text label={e.speakerTitle} value={person.title} locale={locale} onChange={title => set({ ...person, title: optional(title) })} />
        <Text label={e.bio} value={person.bio} locale={locale} multiline onChange={bio => set({ ...person, bio: optional(bio) })} />
        {picker(e.photo, person.photo, photo => set({ ...person, photo }), true)}
      </>} /></>;
    case "partners": return <>{heading}<Rows items={section.partners} addLabel={e.addPartner} blank={() => ({ name: "" })} onChange={partners => onChange({ ...section, partners })}
      render={(partner, set) => <>
        <AssociationField label={e.name} value={partner.name} onChange={name => set({ ...partner, name })} />
        <AssociationField label={e.link} value={partner.href ?? ""} placeholder="https://" onChange={href => set({ ...partner, href: href || undefined })} />
        {picker(e.logo, partner.logo, logo => set({ ...partner, logo }), true)}
      </>} /></>;
    case "agenda": return <>{heading}<Rows items={section.items} addLabel={e.addAgendaItem} blank={() => ({ time: "", title: { en: "" } })} onChange={items => onChange({ ...section, items })}
      render={(item, set) => <>
        <AssociationField label={e.time} value={item.time} placeholder="18:30" onChange={time => set({ ...item, time })} />
        <Text label={e.itemTitle} value={item.title} locale={locale} onChange={title => set({ ...item, title })} />
        <Text label={e.detail} value={item.detail} locale={locale} multiline onChange={detail => set({ ...item, detail: optional(detail) })} />
      </>} /></>;
    case "faq": return <>{heading}<Rows items={section.items} addLabel={e.addQuestion} blank={() => ({ question: { en: "" }, answer: { en: "" } })} onChange={items => onChange({ ...section, items })}
      render={(item, set) => <>
        <Text label={e.question} value={item.question} locale={locale} onChange={question => set({ ...item, question })} />
        <Text label={e.answer} value={item.answer} locale={locale} multiline onChange={answer => set({ ...item, answer })} />
      </>} /></>;
  }
}

function sectionSummary(section: EventSection, locale: MembershipLocale): string {
  const heading = "heading" in section ? read(section.heading, locale) || section.heading?.en : "";
  if (heading) return heading;
  switch (section.kind) {
    case "text": return (read(section.body, locale) || section.body.en).slice(0, 80);
    case "image": return read(section.caption, locale) || read(section.image.alt, locale);
    case "gallery": return String(section.images.length);
    case "speakers": return section.people.map(person => person.name).filter(Boolean).join(", ");
    case "partners": return section.partners.map(partner => partner.name).filter(Boolean).join(", ");
    case "agenda": case "faq": return String(section.items.length);
  }
}

function SortableSection({ section, open, onToggle, onChange, onRemove, ctx }: { section: EventSection; open: boolean; onToggle: () => void; onChange: (next: EventSection) => void; onRemove: () => void; ctx: Ctx }) {
  const e = useT().associationPage.eventPage;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: section.id });
  const Icon = KIND_ICONS[section.kind];
  return <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} data-section-card={section.id}
    className={cn("rounded-2xl border bg-background", isDragging ? "z-10 border-primary shadow-lg" : "border-border", section.hidden ? "opacity-60" : "")}>
    <div className="flex items-center gap-1 p-2">
      <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners} aria-label={format(e.dragSection, { section: e.kinds[section.kind] })}
        className="inline-flex size-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-muted-foreground hover:bg-accent active:cursor-grabbing md:size-8"><GripVertical aria-hidden className="size-4" /></button>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-1 text-left md:min-h-8">
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-sm font-medium">{e.kinds[section.kind]}</span>
        <span className="min-w-0 truncate text-sm text-muted-foreground">{sectionSummary(section, ctx.locale)}</span>
        <ChevronDown aria-hidden className={cn("ml-auto size-4 shrink-0 transition-transform", open ? "rotate-180" : "")} />
      </button>
      <Button type="button" size="sm" variant="ghost" className="min-h-11 md:min-h-8" aria-label={section.hidden ? e.show : e.hide} aria-pressed={section.hidden} onClick={() => onChange({ ...section, hidden: !section.hidden })}>
        {section.hidden ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}</Button>
      <Button type="button" size="sm" variant="ghost" className="min-h-11 text-destructive md:min-h-8" aria-label={e.removeSection} onClick={onRemove}><Trash2 aria-hidden className="size-4" /></Button>
    </div>
    {open ? <div className="space-y-4 border-t border-border p-4"><SectionFields section={section} onChange={onChange} ctx={ctx} /></div> : null}
  </li>;
}

/** The live website in a frame: it listens for this draft and renders it with the site's own design. */
function SitePreview({ url, device, payload, onUnsupported }: { url: string; device: "desktop" | "phone"; payload: unknown; onUnsupported: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null), [ready, setReady] = useState(false);
  const origin = useMemo(() => { try { return new URL(url).origin; } catch { return ""; } }, [url]);
  useEffect(() => {
    const onMessage = (message: MessageEvent) => { if (message.origin === origin && message.data?.type === `${PREVIEW_MESSAGE}:ready`) setReady(true); };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin]);
  // A site without the preview page never answers; move on instead of showing a blank frame.
  const giveUp = useRef(onUnsupported);
  giveUp.current = onUnsupported;
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => giveUp.current(), 8000);
    return () => clearTimeout(timer);
  }, [ready, url]);
  useEffect(() => {
    if (!ready || !origin) return;
    const timer = setTimeout(() => frame.current?.contentWindow?.postMessage({ type: PREVIEW_MESSAGE, ...(payload as object) }, origin), 120);
    return () => clearTimeout(timer);
  }, [ready, origin, payload]);
  return <div className={cn("mx-auto overflow-hidden rounded-2xl border border-border bg-background shadow-sm", device === "phone" ? "w-[390px] max-w-full" : "w-full")}>
    <iframe ref={frame} title="preview" src={`${url.replace(/\/$/, "")}/preview/event/`} className="block h-[75vh] w-full" />
  </div>;
}

export function EventPageEditor({ workspaceId, event }: { workspaceId: string; event: AssociationEvent }) {
  const t = useT().associationPage, e = t.eventPage, c = t.content;
  const pages = useCachedResource(associationPageCacheKey(workspaceId, "site-content:event-pages"), () => getSiteContentDraft(workspaceId, "event-pages"));
  const settings = useCachedResource(associationPageCacheKey(workspaceId, "site-content:settings"), () => getSiteContentDraft(workspaceId, "settings"));
  const media = useCachedResource(associationPageCacheKey(workspaceId, "website-media"), () => listWebsiteMedia(workspaceId));
  const names = useWebsiteSiteNames(workspaceId, true);
  const action = useAssociationAction(workspaceId);
  const [locale, setLocale] = useState<MembershipLocale>("en");
  const [editing, setEditing] = useState<EventPageContent | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const [previewSite, setPreviewSite] = useState("");
  const [published, setPublished] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const doc = (pages.data?.document as EventPagesDocument | null) ?? { schemaVersion: 1, pages: [] };
  const live = (pages.data?.published as EventPagesDocument | null)?.pages.find(page => page.event === event.slug);
  const saved = doc.pages.find(page => page.event === event.slug);
  const page: EventPageContent = editing ?? saved ?? { event: event.slug, sections: [] };
  const dirty = editing !== null && !same(editing, saved ?? { event: event.slug, sections: [] });
  const unpublished = !dirty && !same(saved ?? null, live ?? null);
  const othersUnpublished = doc.pages.filter(item => item.event !== event.slug
    && !same(item, (pages.data?.published as EventPagesDocument | null)?.pages.find(other => other.event === item.event) ?? null)).length;
  const sites = Object.entries((settings.data?.published as { sites?: Record<string, { websiteUrl?: string } | undefined> } | null)?.sites ?? {})
    .flatMap(([site, value]) => value?.websiteUrl ? [{ site, url: value.websiteUrl }] : []);
  const [unsupported, setUnsupported] = useState<string[]>([]);
  const previewable = sites.filter(item => !unsupported.includes(item.site));
  const preview = previewable.find(item => item.site === previewSite) ?? previewable[0];
  const set = (next: EventPageContent) => { setEditing(next); setPublished(false); };
  const setSections = (sections: EventSection[]) => set({ ...page, sections });
  const ctx: Ctx = { locale, workspaceId, media: media.data ?? [], onUploaded: () => void media.refresh() };
  const payload = useMemo(() => ({ locale, page,
    event: { title: event.title, description: event.description, startsAt: event.startsAt, endsAt: event.endsAt, timezone: event.timezone, venue: event.venue, mode: event.mode } }), [locale, page, event]);

  async function save() {
    if (!pages.data || !editing) return;
    const next: EventPagesDocument = { schemaVersion: 1, pages: [...doc.pages.filter(item => item.event !== event.slug), editing] };
    if (await action.run(c.save, () => saveSiteContentDraft(workspaceId, "event-pages", pages.data!.version, next), false)) { setEditing(null); await pages.refresh(); }
  }
  async function publish() {
    if (!pages.data || dirty) return;
    if (await action.run(c.publish, () => publishSiteContent(workspaceId, "event-pages", pages.data!.version), false)) { setPublished(true); await pages.refresh(); }
  }
  async function discard() {
    if (await confirmDialog({ title: t.ux.cancelEdit, description: t.ux.cancelHelp, confirmLabel: e.discard, cancelLabel: t.ux.keepEditing })) setEditing(null);
  }
  function drag(end: DragEndEvent) {
    const from = page.sections.findIndex(item => item.id === end.active.id), to = page.sections.findIndex(item => item.id === end.over?.id);
    if (from >= 0 && to >= 0 && from !== to) setSections(arrayMove(page.sections, from, to));
  }
  function add(kind: EventSectionKind) {
    const section = blankSection(kind, page.sections.map(item => item.id));
    setSections([...page.sections, section]); setOpen(section.id);
  }

  return <AssociationListState {...pages}>
    <div className="space-y-4" data-event-page-editor>
      <div className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-background/95 p-2 backdrop-blur">
        {dirty ? <StatusPill status="draft" label={e.unsaved} /> : unpublished ? <StatusPill status="pending" label={c.statusChanges} /> : live ? <StatusPill status="published" label={c.statusPublished} /> : <StatusPill status="draft" tone="neutral" label={c.statusNotStarted} />}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="w-36"><AssociationChoice label={c.language} value={locale} values={LOCALES} labels={LOCALE_LABELS} onChange={value => setLocale(value as MembershipLocale)} /></div>
          {dirty ? <><Button type="button" variant="ghost" className="min-h-11 md:min-h-9" onClick={() => void discard()}>{e.discard}</Button>
            <Button type="button" className="min-h-11 md:min-h-9" disabled={action.pending} onClick={() => void save()}>{c.save}</Button></>
            : <Button type="button" className="min-h-11 md:min-h-9" disabled={action.pending || !unpublished} onClick={() => void publish()}>{c.publish}</Button>}
        </div>
      </div>
      {action.feedback}
      {published ? <InlineNotice tone="success">{c.publishDone}</InlineNotice> : null}
      {unpublished && othersUnpublished ? <InlineNotice tone="neutral">{format(e.othersPublishToo, { count: othersUnpublished })}</InlineNotice> : null}
      {(pages.data?.issueDetails ?? []).length ? <InlineNotice tone="danger" title={c.issuesTitle}><ul className="list-inside list-disc">{pages.data!.issueDetails!.map((issue, i) => <li key={i}>{issue.message}</li>)}</ul></InlineNotice> : null}

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="min-w-0 space-y-5">
          <section className="space-y-4 rounded-2xl border border-border bg-background p-4">
            <h3 className="font-semibold">{e.coverTitle}</h3>
            <ImagePicker workspaceId={workspaceId} label={e.cover} value={page.cover} onChange={cover => set({ ...page, cover })} media={ctx.media} onUploaded={ctx.onUploaded} locale={locale} />
            <Text label={e.summary} value={page.summary} locale={locale} multiline help={e.summaryHelp} onChange={summary => set({ ...page, summary: optional(summary) })} />
          </section>
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><h3 className="font-semibold">{e.sectionsTitle}</h3><p className="text-sm text-muted-foreground">{e.sectionsHelp}</p></div>
              <DropdownMenu>
                <DropdownMenuTrigger className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium hover:bg-accent md:min-h-9"><Plus aria-hidden className="size-4" />{e.addSection}</DropdownMenuTrigger>
                <DropdownMenuContent align="end">{EVENT_SECTION_KINDS.map(kind => { const Icon = KIND_ICONS[kind]; return <DropdownMenuItem key={kind} className="min-h-11 sm:min-h-0" onClick={() => add(kind)}><Icon aria-hidden className="size-4" /><span className="flex-1">{e.kinds[kind]}</span></DropdownMenuItem>; })}</DropdownMenuContent>
              </DropdownMenu>
            </div>
            {page.sections.length === 0 ? <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{e.noSections}</p> :
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={drag}>
                <SortableContext items={page.sections.map(item => item.id)} strategy={verticalListSortingStrategy}>
                  <ul className="space-y-2">{page.sections.map((section, index) => <SortableSection key={section.id} section={section} open={open === section.id} ctx={ctx}
                    onToggle={() => setOpen(open === section.id ? null : section.id)}
                    onChange={next => setSections(page.sections.map((old, i) => i === index ? next : old))}
                    onRemove={() => setSections(page.sections.filter((_, i) => i !== index))} />)}</ul>
                </SortableContext>
              </DndContext>}
          </section>
        </div>
        <aside className="min-w-0 space-y-3 xl:sticky xl:top-24 xl:self-start" aria-label={e.previewTitle}>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="mr-auto font-semibold">{e.previewTitle}</h3>
            {previewable.length > 1 ? <div className="w-40"><AssociationChoice label={e.previewSite} value={preview?.site ?? ""} values={previewable.map(item => item.site)} labels={Object.fromEntries(previewable.map(item => [item.site, websiteSiteLabel(item.site, names)]))} onChange={setPreviewSite} /></div> : null}
            <Segmented label={e.previewTitle} value={device} onChange={setDevice} options={[{ value: "desktop", label: c.desktop }, { value: "phone", label: c.phone }]} />
          </div>
          {preview ? <SitePreview key={preview.site} url={preview.url} device={device} payload={payload} onUnsupported={() => setUnsupported(old => [...new Set([...old, preview.site])])} />
            : <InlineNotice tone="neutral">{e.noPreviewSite}</InlineNotice>}
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">{device === "phone" ? <Smartphone aria-hidden className="size-3.5" /> : <Monitor aria-hidden className="size-3.5" />}{e.previewHelp}</p>
        </aside>
      </div>
    </div>
  </AssociationListState>;
}
