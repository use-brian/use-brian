"use client";

/** Website submissions and linked CRM people and audiences. [COMP:app-web/association] */
import Link from "next/link";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUpRight, Contact, Inbox, Mail } from "lucide-react";
import { fetchCrmRecordPage, getCrmSubmission, updateCrmSubmission, listCrmIntakeDefinitions, listCrmSegments, listCrmSubmissionPage, previewCrmSegment, type CrmPublicRecord, type CrmSubmission } from "@/lib/api/crm";
import { Button } from "@/components/ui/button";
import { crmCollectionHref, crmRecordHref } from "@/lib/crm-view";
import { format } from "@/lib/i18n/format";
import { useT } from "@/lib/i18n/client";
import { associationPageCacheKey } from "@/lib/surface-prefetch";
import { AssociationChoice, AssociationField, AssociationListState, useAssociationAction, useAssociationProjection } from "../operator-controls";
import { useAssociationDraftGuard } from "../workspace-ui";
import { associationHref } from "../navigation";
import { EmptyState, InlineNotice, PageHeader, ResponsiveTable, Segmented, StatusPill, associationDate } from "../ui";

type View = "people" | "forms" | "newsletter";
const VIEWS: readonly View[] = ["people", "forms", "newsletter"];
const openLink = (href: string, label: string) => <Link href={href} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary md:min-h-8">{label}<ArrowUpRight aria-hidden className="size-4" /></Link>;

/** Cursor paging with a back stack: the list shows one page and never claims a total it has not read.
 * Every read here is a protected CRM projection: it renews on the shared interval and expires at the
 * 30-second request-start deadline, so an open list never outlives the viewer's department access. */
function usePaged<T>(key: string, load: (cursor: string | null) => Promise<{ items: T[]; nextCursor: string | null }>) {
  const [position, setPosition] = useState({ key, stack: [null] as (string | null)[] });
  const stack = position.key === key ? position.stack : [null];
  const cursor = stack[stack.length - 1] ?? null;
  const page = useAssociationProjection(`${key}:${cursor ?? ""}`, () => load(cursor));
  return { ...page,
    next: page.data?.nextCursor && !stack.includes(page.data.nextCursor) ? () => setPosition({ key, stack: [...stack, page.data!.nextCursor] }) : undefined,
    previous: stack.length > 1 ? () => setPosition({ key, stack: stack.slice(0, -1) }) : undefined };
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
          { key: "name", label: m.name, primary: true, cell: row => <Link className="inline-flex min-h-11 md:min-h-9 items-center text-primary" href={associationHref(workspaceId, "memberships", { contactId: row.id })}>{row.name}</Link> },
          { key: "email", label: u.columnEmail, cell: row => row.email ?? <span className="text-muted-foreground">{u.noEmail}</span> },
          { key: "phone", label: u.columnPhone, hideBelowMd: true, cell: row => row.phone ?? "" },
        ]}
        actions={row => openLink(crmRecordHref(workspaceId, "contact", row.id), u.openInCrm)} />
    </AssociationListState>
  </div>;
}

const SUBMISSION_STATUSES = ["all", "new", "in_progress", "resolved", "spam"] as const;
type SubmissionFilter = (typeof SUBMISSION_STATUSES)[number];

function submissionHref(workspaceId: string, form: string, status: SubmissionFilter, submission?: string) {
  return associationHref(workspaceId, "contacts", {
    view: "forms",
    ...(form ? { form } : {}),
    ...(status !== "all" ? { status } : {}),
    ...(submission ? { submission } : {}),
  });
}

function FormsView({ workspaceId, form, status }: { workspaceId: string; form: string; status: SubmissionFilter }) {
  const t = useT().associationPage, u = t.ux, m = t.manage, router = useRouter();
  const crm = useT().crmPage.operations;
  const definitions = useAssociationProjection(associationPageCacheKey(workspaceId, "intake-definitions"), () => listCrmIntakeDefinitions(workspaceId));
  const page = usePaged(associationPageCacheKey(workspaceId, "submissions", { form, status }), async cursor => {
    const result = await listCrmSubmissionPage(workspaceId, { definitionKey: form || undefined, status: status === "all" ? undefined : status, cursor });
    return { items: result.submissions, nextCursor: result.nextCursor };
  });
  const forms = definitions.data ?? [];
  const formKeys = [...new Set([...forms.map(definition => definition.definitionKey), ...(form ? [form] : [])])];
  const formNames = Object.fromEntries(forms.map(definition => [definition.definitionKey, definition.label]));
  return <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-2">
      <AssociationChoice label={u.formName} value={form || "all"} values={["all", ...formKeys]}
        labels={{ all: u.allForms, ...(form ? { [form]: form } : {}), ...formNames }}
        onChange={next => router.replace(submissionHref(workspaceId, next === "all" ? "" : next, status))} />
      <AssociationChoice label={u.columnStatus} value={status} values={SUBMISSION_STATUSES}
        labels={{ all: u.allStatuses, ...crm.submissionStatusLabels }}
        onChange={next => router.replace(submissionHref(workspaceId, form, next as SubmissionFilter))} />
    </div>
    <AssociationListState {...page}>
      <ResponsiveTable rows={page.data?.items ?? []} rowKey={row => row.id} rowData={row => ({ "data-submission-row": row.id })}
        empty={<EmptyState icon={Inbox} title={crm.noSubmissions}
          action={(form || status !== "all") ? <Link className="inline-flex min-h-11 items-center text-sm font-medium text-primary" href={submissionHref(workspaceId, "", "all")}>{t.staff.showAllSubmissions}</Link> : undefined} />}
        columns={[
          { key: "who", label: m.name, primary: true, cell: row => <Link className="inline-flex min-h-11 items-center font-medium text-primary md:min-h-9" href={submissionHref(workspaceId, form, status, row.id)}>{row.contactName}</Link> },
          { key: "form", label: u.formName, cell: row => row.definitionLabel ?? crm.legacySubmission },
          { key: "when", label: u.submitted, hideBelowMd: true, cell: row => associationDate(row.submittedAt) },
          { key: "status", label: u.columnStatus, cell: row => <StatusPill status={row.status === "new" ? "pending" : row.status === "resolved" ? "completed" : row.status} label={crm.submissionStatusLabels[row.status]} /> },
        ]}
        actions={row => <Link className="inline-flex min-h-11 items-center text-sm font-medium text-primary md:min-h-9" href={submissionHref(workspaceId, form, status, row.id)}>{t.staff.reviewSubmission}</Link>} />
    </AssociationListState>
  </div>;
}

function SubmissionDetail({ workspaceId, id, back }: { workspaceId: string; id: string; back: string }) {
  const { associationPage: t, crmPage: { operations: crm } } = useT();
  const action = useAssociationAction(workspaceId);
  const read = useAssociationProjection(associationPageCacheKey(workspaceId, "submission", { id }), () => getCrmSubmission(workspaceId, id));
  const row = read.data;
  const [status, setStatus] = useState<CrmSubmission["status"] | null>(null);
  const [note, setNote] = useState("");
  useAssociationDraftGuard(!!note.trim() || (status !== null && status !== row?.status));
  const fields = row?.definitionSchemaSnapshot?.fields;
  const labels = new Map<string, string>();
  if (Array.isArray(fields)) {
    for (const field of fields) {
      if (field && typeof field.key === "string" && typeof field.label === "string") labels.set(field.key, field.label);
    }
  }
  async function update(changes: Parameters<typeof updateCrmSubmission>[2]) {
    if (read.error) return;
    await action.run(t.manage.save, async () => {
      await updateCrmSubmission(workspaceId, id, changes);
      await read.refresh();
      if (changes.note) setNote("");
      if (changes.status) setStatus(null);
    }, false);
  }
  return <section className="space-y-5" data-submission-detail>
    <PageHeader title={row?.contactName ?? t.staff.reviewSubmission} back={{ label: t.staff.backSubmissions, href: back }}
      description={row ? `${row.definitionLabel ?? crm.legacySubmission} · ${associationDate(row.submittedAt)}` : undefined}
      actions={row ? openLink(crmRecordHref(workspaceId, "contact", row.contactId), t.ux.openInCrm) : undefined} />
    {action.outcome === "failed" ? <InlineNotice tone="danger">{crm.submissionSaveFailed}</InlineNotice> : action.feedback}
    <AssociationListState {...read}>
      {row && <>
        <div className="flex flex-wrap items-end gap-3 rounded-xl border p-4">
          <div className="w-full max-w-xs"><AssociationChoice label={t.ux.columnStatus} value={status ?? row.status}
            values={SUBMISSION_STATUSES.slice(1)} labels={crm.submissionStatusLabels}
            onChange={next => setStatus(next as CrmSubmission["status"])} disabled={action.pending || !!read.error} /></div>
          <Button type="button" className="min-h-11 md:min-h-9"
            disabled={!status || status === row.status || action.pending || !!read.error}
            onClick={() => { if (status) void update({ status }); }}>{t.manage.save}</Button>
        </div>
        <section className="space-y-3 rounded-xl border p-4">
          <h3 className="font-semibold">{crm.submittedFields}</h3>
          <dl className="grid gap-3 sm:grid-cols-2">
            {Object.entries(row.fields ?? {}).map(([key, value]) => <div className="min-w-0 rounded-md bg-muted/35 p-3" key={key}>
              <dt className="break-words text-sm font-medium">{labels.get(key) ?? key.replaceAll("_", " ")}</dt>
              <dd className="mt-1 whitespace-pre-wrap break-words text-sm">{typeof value === "string" ? value : JSON.stringify(value)}</dd>
            </div>)}
          </dl>
        </section>
        <section className="space-y-3 rounded-xl border p-4">
          <AssociationField label={crm.addNote} multiline value={note} onChange={setNote} disabled={action.pending || !!read.error} />
          <Button type="button" variant="outline" className="min-h-11 md:min-h-9"
            disabled={!note.trim() || action.pending || !!read.error} onClick={() => void update({ note: note.trim() })}>{crm.saveNote}</Button>
          {!!row.notes?.length && <ul className="space-y-2">{row.notes.map(item => <li className="rounded-md bg-muted/35 p-3 text-sm" key={item.id}>
            <p className="whitespace-pre-wrap break-words">{item.body}</p><time className="text-xs text-muted-foreground" dateTime={item.createdAt}>{associationDate(item.createdAt)}</time>
          </li>)}</ul>}
        </section>
      </>}
    </AssociationListState>
  </section>;
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
  const view: View = raw && VIEWS.includes(raw) ? raw : "forms";
  const form = search?.get("form") ?? "";
  const rawStatus = search?.get("status") as SubmissionFilter | null;
  const status = rawStatus && SUBMISSION_STATUSES.includes(rawStatus) ? rawStatus : "all";
  const submission = search?.get("submission");
  if (view === "forms" && submission) return <SubmissionDetail key={submission} workspaceId={workspaceId} id={submission} back={submissionHref(workspaceId, form, status)} />;
  const labels: Record<View, string> = { people: u.tabPeople, forms: u.tabForms, newsletter: u.tabNewsletter };
  return <section className="space-y-5" data-association-contacts>
    <PageHeader title={t.staff.submissions} description={t.staff.submissionsHelp} actions={openLink(crmCollectionHref(workspaceId), t.openCrm)}>
      <Segmented label={u.goTo} value={view} onChange={next => router.replace(associationHref(workspaceId, "contacts", { view: next }))} options={VIEWS.map(id => ({ value: id, label: labels[id] }))} />
    </PageHeader>
    {view === "people" ? <PeopleView workspaceId={workspaceId} /> : null}
    {view === "forms" ? <FormsView workspaceId={workspaceId} form={form} status={status} /> : null}
    {view === "newsletter" ? <NewsletterView workspaceId={workspaceId} /> : null}
  </section>;
}
