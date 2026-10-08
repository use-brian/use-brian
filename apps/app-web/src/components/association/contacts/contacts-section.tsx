"use client";

/** Contacts & forms: read-only views of the workspace CRM that the websites write into; follow-up happens in the CRM. [COMP:app-web/association] */
import Link from "next/link";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUpRight, Contact, Inbox, Mail } from "lucide-react";
import { fetchCrmRecordPage, listCrmIntakeDefinitions, listCrmSegments, listCrmSubmissionPage, previewCrmSegment, type CrmPublicRecord, type CrmSubmission } from "@/lib/api/crm";
import { crmCollectionHref, crmRecordHref } from "@/lib/crm-view";
import { format } from "@/lib/i18n/format";
import { useT } from "@/lib/i18n/client";
import { associationPageCacheKey } from "@/lib/surface-prefetch";
import { AssociationChoice, AssociationField, AssociationListState, useAssociationProjection } from "../operator-controls";
import { associationHref } from "../navigation";
import { EmptyState, PageHeader, ResponsiveTable, Segmented, StatusPill, associationDate } from "../ui";

type View = "people" | "forms" | "newsletter";
const VIEWS: readonly View[] = ["people", "forms", "newsletter"];
const openLink = (href: string, label: string) => <Link href={href} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary md:min-h-8">{label}<ArrowUpRight aria-hidden className="size-4" /></Link>;

/** Cursor paging with a back stack: the list shows one page and never claims a total it has not read.
 * Every read here is a protected CRM projection: it renews on the shared interval and expires at the
 * 30-second request-start deadline, so an open list never outlives the viewer's department access. */
function usePaged<T>(key: string, load: (cursor: string | null) => Promise<{ items: T[]; nextCursor: string | null }>) {
  const [stack, setStack] = useState<(string | null)[]>([null]);
  const cursor = stack[stack.length - 1] ?? null;
  const page = useAssociationProjection(`${key}:${cursor ?? ""}`, () => load(cursor));
  return { ...page,
    next: page.data?.nextCursor ? () => setStack(old => [...old, page.data!.nextCursor]) : undefined,
    previous: stack.length > 1 ? () => setStack(old => old.slice(0, -1)) : undefined };
}

function PeopleView({ workspaceId }: { workspaceId: string }) {
  const t = useT().associationPage, u = t.ux, m = t.manage;
  const [query, setQuery] = useState("");
  const q = query.trim();
  const page = usePaged(associationPageCacheKey(workspaceId, "contacts", { q }), async cursor => {
    const result = await fetchCrmRecordPage<Extract<CrmPublicRecord, { kind: "contact" }>>(workspaceId, { kind: "contact", q: q || undefined, cursor, limit: 25 });
    return { items: result.items, nextCursor: result.nextCursor };
  });
  return <div className="space-y-4">
    <div className="max-w-md"><AssociationField label={u.searchContacts} value={query} onChange={setQuery} /></div>
    <AssociationListState {...page}>
      <ResponsiveTable rows={page.data?.items ?? []} rowKey={row => row.id} rowData={row => ({ "data-contact-row": row.id })}
        empty={<EmptyState icon={Contact} title={u.noContacts} />}
        columns={[
          { key: "name", label: m.name, primary: true, cell: row => row.name },
          { key: "email", label: u.columnEmail, cell: row => row.email ?? <span className="text-muted-foreground">{u.noEmail}</span> },
          { key: "phone", label: u.columnPhone, hideBelowMd: true, cell: row => row.phone ?? "" },
        ]}
        actions={row => openLink(crmRecordHref(workspaceId, "contact", row.id), u.openInCrm)} />
    </AssociationListState>
  </div>;
}

function FormsView({ workspaceId, form }: { workspaceId: string; form: string }) {
  const t = useT().associationPage, u = t.ux, m = t.manage, router = useRouter();
  const [status, setStatus] = useState<CrmSubmission["status"] | "all">("new");
  const definitions = useAssociationProjection(associationPageCacheKey(workspaceId, "intake-definitions"), () => listCrmIntakeDefinitions(workspaceId));
  const page = usePaged(associationPageCacheKey(workspaceId, "submissions", { form, status }), async cursor => {
    const result = await listCrmSubmissionPage(workspaceId, { definitionKey: form || undefined, status: status === "all" ? undefined : status, cursor });
    return { items: result.submissions, nextCursor: result.nextCursor };
  });
  const statusLabels: Record<CrmSubmission["status"], string> = { new: u.submissionNew, in_progress: u.submissionInProgress, resolved: u.submissionResolved, spam: u.submissionSpam };
  const forms = (definitions.data ?? []).filter(definition => definition.active);
  return <div className="space-y-4">
    <div className="flex flex-wrap items-end gap-3">
      <div className="w-full max-w-md"><AssociationChoice label={u.formName} value={form || "all"} values={["all", ...forms.map(definition => definition.definitionKey)]}
        labels={{ all: u.allForms, ...Object.fromEntries(forms.map(definition => [definition.definitionKey, definition.label])) }}
        onChange={next => router.replace(associationHref(workspaceId, "contacts", { view: "forms", ...(next !== "all" ? { form: next } : {}) }))} /></div>
    <Segmented label={u.filters} value={status} onChange={setStatus} options={[{ value: "new", label: statusLabels.new }, { value: "in_progress", label: statusLabels.in_progress }, { value: "resolved", label: statusLabels.resolved }, { value: "all", label: u.allStatuses }]} />
    </div>
    <AssociationListState {...page}>
      <ResponsiveTable rows={page.data?.items ?? []} rowKey={row => row.id} rowData={row => ({ "data-submission-row": row.id })}
        empty={<EmptyState icon={Inbox} title={u.noSubmissions} />}
        columns={[
          { key: "who", label: m.name, primary: true, cell: row => row.contactName },
          { key: "form", label: u.formName, cell: row => row.definitionLabel ?? "" },
          { key: "when", label: u.submitted, hideBelowMd: true, cell: row => associationDate(row.submittedAt) },
          { key: "status", label: u.columnStatus, cell: row => <StatusPill status={row.status === "new" ? "pending" : row.status === "resolved" ? "completed" : row.status} label={statusLabels[row.status]} /> },
        ]}
        actions={row => openLink(`${crmCollectionHref(workspaceId)}?${new URLSearchParams({ review: "submissions", submission: row.id })}`, u.openInCrm)} />
    </AssociationListState>
  </div>;
}

function AudienceCard({ workspaceId, id, name, description }: { workspaceId: string; id: string; name: string; description: string }) {
  const u = useT().associationPage.ux;
  const preview = useAssociationProjection(associationPageCacheKey(workspaceId, "segment-preview", { id }), () => previewCrmSegment(workspaceId, id));
  const total = preview.data?.snapshotIds.length;
  return <article className="space-y-3 rounded-2xl border border-border bg-background p-5" data-audience={id}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h3 className="font-semibold">{name}</h3>{description ? <p className="text-sm text-muted-foreground">{description}</p> : null}</div>
      {total !== undefined ? <StatusPill status="active" tone="info" label={format(u.peopleCount, { count: total })} /> : null}
    </div>
    {preview.data?.rows.length ? <>
      <ul className="divide-y divide-border text-sm">{preview.data.rows.map(row => <li key={row.id} className="py-1.5"><Link className="hover:underline" href={crmRecordHref(workspaceId, "contact", row.id)}>{row.name}</Link></li>)}</ul>
      {total !== undefined && total > preview.data.rows.length ? <p className="text-xs text-muted-foreground">{format(u.showingFirst, { count: preview.data.rows.length })}</p> : null}
    </> : null}
    {openLink(`${crmCollectionHref(workspaceId)}?${new URLSearchParams({ review: "segments", segment: id })}`, u.openInCrm)}
  </article>;
}

function NewsletterView({ workspaceId }: { workspaceId: string }) {
  const u = useT().associationPage.ux;
  const segments = useAssociationProjection(associationPageCacheKey(workspaceId, "audiences"), () => listCrmSegments(workspaceId, "person"));
  const rows = (segments.data?.segments ?? []).filter(segment => !segment.archivedAt);
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">{u.audiencesHelp}</p>
    <AssociationListState {...segments}>
      {rows.length === 0 ? <EmptyState icon={Mail} title={u.noAudiences} /> : <div className="grid gap-3 md:grid-cols-2">
        {rows.map(segment => <AudienceCard key={segment.id} workspaceId={workspaceId} id={segment.id} name={segment.name} description={segment.description} />)}
      </div>}
    </AssociationListState>
  </div>;
}

export function AssociationContactsSection({ workspaceId }: { workspaceId: string }) {
  const t = useT().associationPage, u = t.ux, router = useRouter(), search = useSearchParams();
  const raw = search?.get("view") as View | null;
  const view: View = raw && VIEWS.includes(raw) ? raw : "people";
  const labels: Record<View, string> = { people: u.tabPeople, forms: u.tabForms, newsletter: u.tabNewsletter };
  return <section className="space-y-5" data-association-contacts>
    <PageHeader title={u.navContacts} description={u.contactsPageHelp} actions={openLink(crmCollectionHref(workspaceId), t.openCrm)}>
      <Segmented label={u.goTo} value={view} onChange={next => router.replace(associationHref(workspaceId, "contacts", { view: next }))} options={VIEWS.map(id => ({ value: id, label: labels[id] }))} />
    </PageHeader>
    {view === "people" ? <PeopleView workspaceId={workspaceId} /> : null}
    {view === "forms" ? <FormsView key={search?.get("form") ?? ""} workspaceId={workspaceId} form={search?.get("form") ?? ""} /> : null}
    {view === "newsletter" ? <NewsletterView workspaceId={workspaceId} /> : null}
  </section>;
}
