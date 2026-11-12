"use client";

/** A member's event records, backed by the canonical CRM participation APIs. [COMP:app-web/association] */
import Link from "next/link";
import { useState } from "react";
import { CalendarDays, Plus } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import {
  listCrmParticipation, recordCrmParticipation, updateCrmParticipation,
  type CrmLookupRow, type CrmParticipationStatus,
} from "@/lib/api/crm";
import { associationPageCacheKey } from "@/lib/surface-prefetch";
import { Button, buttonVariants } from "@/components/ui/button";
import { associationHref } from "./navigation";
import { AssociationChoice, AssociationListState, useAssociationAction, useAssociationIntent, useAssociationProjection } from "./operator-controls";
import { AssociationCatalogPicker } from "./workspace-ui";
import { EmptyState, InlineNotice, ResponsiveTable, StatusPill, associationDate } from "./ui";

const statuses = ["registered", "attended", "cancelled", "no_show"] as const;

export function MemberEventHistory({ workspaceId, contact, canManage }: { workspaceId: string; contact: CrmLookupRow; canManage: boolean }) {
  const strings = useT(), t = strings.associationPage, s = t.staff;
  const labels = strings.crmPage.operations.participationStatusLabels;
  const history = useAssociationProjection(associationPageCacheKey(workspaceId, "participation", { contactId: contact.id }),
    () => listCrmParticipation(workspaceId, { contactId: contact.id }));
  const action = useAssociationAction(workspaceId);
  const [adding, setAdding] = useState(false);
  const [event, setEvent] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [status, setStatus] = useState<CrmParticipationStatus>("attended");
  const intent = useAssociationIntent(workspaceId, "participation", `${contact.id}:${event[0] ?? ""}`);
  async function record() {
    const eventId = event[0];
    if (!eventId || !canManage || history.error || action.pending || history.data?.some(row => row.eventId === eventId)) return;
    await action.run(s.addEventRecord, async () => {
      await recordCrmParticipation(workspaceId, {
        contactId: contact.id, attendeeName: contact.name, eventId, sourceKind: "manual", sourceId: intent.identity(), status,
      });
      setAdding(false); setEvent([]); await history.refresh();
    }, false);
  }

  return <section className="space-y-4" data-member-event-history aria-labelledby="member-history-title">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="member-history-title" className="text-xl font-semibold">{s.eventHistory}</h2>
      {canManage && <Button type="button" variant="outline" className="min-h-11 md:min-h-9" aria-expanded={adding} onClick={() => {
        setAdding(value => !value); setEditing(null); setStatus("attended");
      }}><Plus aria-hidden className="size-4" />{s.addEventRecord}</Button>}
    </div>
    {adding && canManage && <fieldset disabled={action.pending || !!history.error} className="space-y-4 rounded-xl border border-border bg-background p-5">
      <legend className="sr-only">{s.addEventRecord}</legend>
      <AssociationCatalogPicker workspaceId={workspaceId} resource="events" selected={event} onChange={setEvent} single />
      {history.data?.some(row => row.eventId === event[0]) && <InlineNotice tone="warning">{s.alreadyRecorded}</InlineNotice>}
      <AssociationChoice label={t.manage.status} values={statuses} labels={labels} value={status} onChange={value => setStatus(value as CrmParticipationStatus)} />
      <Button type="button" className="min-h-11 md:min-h-9" disabled={!event.length || !history.data || history.data.some(row => row.eventId === event[0])} onClick={() => void record()}>{t.manage.save}</Button>
    </fieldset>}
    {action.feedback}
    <AssociationListState {...history}>
      <ResponsiveTable rows={history.data ?? []} rowKey={row => row.id} empty={<EmptyState icon={CalendarDays} title={s.noEventHistory} />}
        columns={[
          { key: "event", label: t.ux.eventsNav, primary: true, cell: row => <Link className="inline-flex min-h-11 md:min-h-9 items-center text-primary" href={associationHref(workspaceId, "events", { eventId: row.eventId, view: "guests" })}>{row.eventTitle}</Link> },
          { key: "status", label: t.manage.status, cell: row => <StatusPill status={row.status} label={labels[row.status]} /> },
          { key: "updated", label: s.updated, cell: row => associationDate(row.updatedAt, "date") },
        ]}
        actions={canManage ? row => row.commerceManaged || row.sourceKind === "source_order" ? (
          <Link href={associationHref(workspaceId, "events", { eventId: row.eventId, view: "guests" })} className={buttonVariants({ size: "sm", variant: "outline", className: "min-h-11 md:min-h-9" })}>{t.ux.guests}</Link>
        ) : editing === row.id ? <div className="w-full min-w-0 space-y-2">
          <AssociationChoice label={t.manage.status} value={status} values={statuses} labels={labels} onChange={value => setStatus(value as CrmParticipationStatus)} />
          <div className="flex flex-wrap gap-2">
            <Button type="button" className="min-h-11 md:min-h-9" disabled={status === row.status || action.pending || !!history.error} onClick={() => void action.run(t.manage.save, async () => {
              await updateCrmParticipation(workspaceId, row.id, status);
              setEditing(null); await history.refresh();
            }, status === "cancelled" ? { description: s.cancelEventRecord, destructive: true } : false)}>{t.manage.save}</Button>
            <Button type="button" variant="ghost" className="min-h-11 md:min-h-9" onClick={() => setEditing(null)}>{t.cancel}</Button>
          </div>
        </div> : <Button type="button" variant="outline" className="min-h-11 md:min-h-9" disabled={!!history.error} onClick={() => {
          setAdding(false); setEditing(row.id); setStatus(row.status);
        }}>{t.manage.edit}</Button> : undefined}
      />
    </AssociationListState>
  </section>;
}
