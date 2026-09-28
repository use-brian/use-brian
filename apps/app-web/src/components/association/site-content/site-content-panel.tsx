"use client";
/** One website page: Edit → Save changes → Preview → Publish. Publishing is reversible (publish again), so it has no review dialog. [COMP:app-web/site-content] */
import { useState } from "react";
import { getSiteContentDraft, listWebsiteMedia, publishSiteContent, saveSiteContentDraft, websiteSiteLabel, type MembershipLocale, type SiteContentCollection, type SiteContentDocument, type WebsiteIssue } from "@/lib/api/association";
import { format } from "@/lib/i18n/format";
import { useT } from "@/lib/i18n/client";
import { useCachedResource } from "@/lib/surface-cache";
import { associationPageCacheKey } from "@/lib/surface-prefetch";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { AssociationChoice as Choice, AssociationListState, useAssociationAction } from "../operator-controls";
import { useAssociationModule } from "../module-controls";
import { InlineNotice, PageHeader, Segmented, StatusPill, TechnicalDetails } from "../ui";
import { useWebsiteSiteNames } from "../website/website-status";
import { blankDocument, collectionFields } from "./descriptors";
import { DocumentOutline, FieldsEditor } from "./document-editor";
import { PagePreview } from "./page-preview";

const LOCALES = ["en", "zh-Hant", "zh-Hans"] as const;
const LOCALE_LABELS = { en: "English", "zh-Hant": "繁體中文", "zh-Hans": "简体中文" };

/** Translate a coded issue; site keys become site names. Unknown codes fall back to the server's English message. */
function useIssueText(names: Record<string, string>) {
  const templates = useT().associationPage.content.issues as Record<string, string>;
  return (issue: WebsiteIssue) => {
    const template = templates[issue.code];
    if (!template) return issue.message;
    return format(template, { ...issue.params, ...(issue.params.site ? { site: websiteSiteLabel(issue.params.site, names) } : {}) });
  };
}

export function SiteContentPanel({ workspaceId, collection, back }: { workspaceId: string; collection: SiteContentCollection; back?: { label: string; href: string } }) {
  const t = useT().associationPage, c = t.content;
  const module = useAssociationModule(workspaceId), manage = !!module.data?.canManage;
  const read = useCachedResource(manage ? associationPageCacheKey(workspaceId, `site-content:${collection}`) : null, () => getSiteContentDraft(workspaceId, collection));
  const media = useCachedResource(manage ? associationPageCacheKey(workspaceId, "website-media") : null, () => listWebsiteMedia(workspaceId));
  const names = useWebsiteSiteNames(workspaceId, manage);
  const issueText = useIssueText(names);
  const action = useAssociationAction(workspaceId);
  const [editing, setEditing] = useState<{ version: number; document: SiteContentDocument; dirty: boolean } | null>(null);
  const [locale, setLocale] = useState<MembershipLocale>("en");
  const [preview, setPreview] = useState(false);
  const [view, setView] = useState<"desktop" | "phone" | "outline">("desktop");
  const [published, setPublished] = useState(false);
  const readers = read.data?.readers ?? [];
  const fields = collectionFields(collection, readers);
  const title = (c.collections as Record<SiteContentCollection, { title: string; help: string }>)[collection];
  const heading = collection.startsWith("home-") ? format(c.homePageFor, { site: readers.map(site => websiteSiteLabel(site, names)).join(", ") }) : title.title;
  const doc = editing?.document ?? read.data?.document ?? null;
  const issues: WebsiteIssue[] = read.data ? read.data.issueDetails ?? read.data.issues.map(message => ({ code: "", params: {}, message })) : [];
  const unpublished = !!read.data?.document && read.data.version !== read.data.publishedRevision;

  async function save() {
    if (!editing) return;
    const current = editing;
    if (await action.run(c.save, () => saveSiteContentDraft(workspaceId, collection, current.version, current.document), false)) {
      setEditing(null); setPreview(true); setPublished(false); await read.refresh();
    }
  }
  async function publish() {
    if (!read.data || editing) return;
    if (await action.run(c.publish, () => publishSiteContent(workspaceId, collection, read.data!.version), false)) {
      setPreview(false); setPublished(true); await read.refresh();
    }
  }
  async function cancel() {
    if (!editing?.dirty || await confirmDialog({ title: t.ux.cancelEdit, description: t.ux.cancelHelp, confirmLabel: t.cancel, cancelLabel: t.ux.keepEditing })) setEditing(null);
  }
  const shown = (value: SiteContentDocument | null | undefined) => view === "outline"
    ? <DocumentOutline fields={fields} value={value} locale={locale} siteNames={names} />
    : <PagePreview fields={fields} value={value} locale={locale} workspaceId={workspaceId} phone={view === "phone"} siteNames={names} />;

  return <section className="space-y-5" data-site-content={collection}>
    <PageHeader title={heading} description={title.help} back={back} />
    {!manage ? <InlineNotice tone="neutral">{t.ux.readOnly}</InlineNotice> : <AssociationListState {...read}>
      {read.data && <>
        <div className="flex flex-wrap items-center gap-2" role="status">
          {read.data.publishedRevision === 0 ? <StatusPill status="draft" tone="neutral" label={c.statusNotStarted} />
            : readers.map(site => read.data!.observations[site]?.revision === read.data!.publishedRevision
              ? <StatusPill key={site} status="published" tone="success" label={format(c.observed, { site: websiteSiteLabel(site, names) })} />
              : <StatusPill key={site} status="pending" tone="info" label={format(c.pending, { site: websiteSiteLabel(site, names) })} />)}
          {unpublished ? <StatusPill status="draft" label={c.statusChanges} /> : null}
        </div>
        {published ? <InlineNotice tone="success">{c.publishDone}</InlineNotice> : null}
        {!doc && <InlineNotice tone="neutral">{c.empty}</InlineNotice>}
        <div className="flex flex-wrap gap-2">
          {!editing && <Button className="min-h-11" variant={unpublished ? "outline" : "default"} onClick={() => { setEditing({ version: read.data!.version, document: structuredClone(doc ?? blankDocument(collection, readers)), dirty: false }); setPreview(false); setPublished(false); }}>{doc ? c.edit : c.create}</Button>}
          {editing && <><Button className="min-h-11" disabled={action.pending || !editing.dirty} onClick={() => void save()}>{c.save}</Button><Button className="min-h-11" variant="outline" onClick={() => void cancel()}>{t.cancel}</Button></>}
          {!editing && doc && !preview && <Button className="min-h-11" variant="outline" onClick={() => setPreview(true)}>{c.preview}</Button>}
          {!editing && unpublished && issues.length === 0 && <Button className="min-h-11" disabled={action.pending} onClick={() => void publish()}>{c.publish}</Button>}
        </div>
        {action.feedback}
        {issues.length > 0 && <InlineNotice tone="danger" title={c.issuesTitle}><ul className="list-inside list-disc">{issues.map((issue, i) => <li key={`${issue.code}:${i}`}>{issueText(issue)}</li>)}</ul></InlineNotice>}
        {doc && <div className="flex flex-wrap items-end gap-3">
          <div className="w-44"><Choice label={c.language} value={locale} values={LOCALES} labels={LOCALE_LABELS} onChange={value => setLocale(value as MembershipLocale)}/></div>
          {!editing ? <Segmented label={c.preview} value={view} onChange={setView} options={[{ value: "desktop", label: c.desktop }, { value: "phone", label: c.phone }, { value: "outline", label: c.outline }]} /> : null}
        </div>}
        {editing && <FieldsEditor fields={fields} value={editing.document} context={{ locale, media: media.data ?? [], workspaceId, disabled: action.pending, sites: readers, siteNames: names }}
          onChange={document => setEditing(old => old ? { ...old, document, dirty: true } : old)}/>}
        {preview && !editing && doc && <div className="grid min-w-0 gap-4 xl:grid-cols-2">{([[c.before, read.data.published], [c.after, doc]] as const).map(([label, value]) =>
          <div key={label} className="min-w-0 space-y-2"><h3 className="font-semibold">{label}</h3>{shown(value)}</div>)}</div>}
        {!editing && !preview && doc && shown(doc)}
        {read.data.publishedRevision > 0 ? <TechnicalDetails rows={[[c.published, String(read.data.publishedRevision)], [c.save, String(read.data.version)]]} /> : null}
      </>}
    </AssociationListState>}
  </section>;
}
