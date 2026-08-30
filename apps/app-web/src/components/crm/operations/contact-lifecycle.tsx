"use client";

/** Contact entitlement and participation lifecycle controls. [COMP:app-web/crm-operations] */

import { useCallback, useEffect, useState } from "react";
import { CalendarCheck, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  grantCrmEntitlement,
  listCrmEntitlementPlans,
  listCrmEntitlements,
  listCrmEvents,
  listCrmParticipation,
  recordCrmParticipation,
  updateCrmEntitlement,
  updateCrmParticipation,
  type CrmEntitlement,
  type CrmEntitlementPlan,
  type CrmEntitlementStatus,
  type CrmEvent,
  type CrmParticipation,
  type CrmParticipationStatus,
} from "@/lib/api/crm";
import { useT } from "@/lib/i18n/client";

const ENTITLEMENT_STATUSES: CrmEntitlementStatus[] = ["pending", "active", "expired", "cancelled"];
const PARTICIPATION_STATUSES: CrmParticipationStatus[] = ["registered", "attended", "cancelled", "no_show"];

function sourceIdentity(contactId: string, eventId: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`;
  return `manual:${contactId}:${eventId}:${suffix}`;
}

export function CrmContactLifecycle({
  workspaceId,
  contactId,
  contactName,
  contactEmail,
}: {
  workspaceId: string;
  contactId: string;
  contactName: string;
  contactEmail?: string | null;
}) {
  const t = useT().crmPage.operations;
  const [plans, setPlans] = useState<CrmEntitlementPlan[]>([]);
  const [entitlements, setEntitlements] = useState<CrmEntitlement[]>([]);
  const [events, setEvents] = useState<CrmEvent[]>([]);
  const [participation, setParticipation] = useState<CrmParticipation[]>([]);
  const [planId, setPlanId] = useState("");
  const [eventId, setEventId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [nextPlans, nextEntitlements, nextEvents, nextParticipation] = await Promise.all([
      listCrmEntitlementPlans(workspaceId, { published: true, limit: 100 }),
      listCrmEntitlements(workspaceId, { contactId, limit: 100 }),
      listCrmEvents(workspaceId, { limit: 100 }),
      listCrmParticipation(workspaceId, { contactId, limit: 100 }),
    ]);
    setPlans(nextPlans);
    setEntitlements(nextEntitlements);
    setEvents(nextEvents);
    setParticipation(nextParticipation);
    setPlanId((current) => current || nextPlans[0]?.id || "");
    setEventId((current) => current || nextEvents[0]?.id || "");
  }, [workspaceId, contactId]);

  useEffect(() => {
    setError(null);
    void reload().catch(() => setError(t.lifecycleLoadFailed));
  }, [reload, t.lifecycleLoadFailed]);

  async function grant() {
    if (!planId || busy) return;
    setBusy(true); setError(null);
    try {
      await grantCrmEntitlement(workspaceId, {
        contactId,
        planId,
        idempotencyKey: `manual:${contactId}:${planId}:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
        status: "active",
        startsAt: new Date().toISOString(),
      });
      await reload();
    } catch { setError(t.lifecycleSaveFailed); }
    finally { setBusy(false); }
  }

  async function changeEntitlement(row: CrmEntitlement, status: CrmEntitlementStatus) {
    if (row.status === status || busy) return;
    if (status === "cancelled" && !await confirmDialog({
      title: t.cancelEntitlementTitle,
      description: t.cancelEntitlementDescription.replace("{plan}", row.planName),
      confirmLabel: t.cancelEntitlement,
      cancelLabel: t.cancel,
      variant: "destructive",
    })) return;
    setBusy(true); setError(null);
    try { await updateCrmEntitlement(workspaceId, row.id, { status }); await reload(); }
    catch { setError(t.lifecycleSaveFailed); }
    finally { setBusy(false); }
  }

  async function register() {
    if (!eventId || busy) return;
    setBusy(true); setError(null);
    try {
      await recordCrmParticipation(workspaceId, {
        contactId,
        eventId,
        sourceKind: "manual",
        sourceId: sourceIdentity(contactId, eventId),
        status: "registered",
        attendeeName: contactName,
        ...(contactEmail ? { attendeeEmail: contactEmail } : {}),
      });
      await reload();
    } catch { setError(t.lifecycleSaveFailed); }
    finally { setBusy(false); }
  }

  async function changeParticipation(row: CrmParticipation, status: CrmParticipationStatus) {
    if (row.status === status || row.commerceManaged || busy) return;
    setBusy(true); setError(null);
    try { await updateCrmParticipation(workspaceId, row.id, status); await reload(); }
    catch { setError(t.lifecycleSaveFailed); }
    finally { setBusy(false); }
  }

  return (
    <section className="mt-4 border-t border-border/60 pt-4" data-crm-contact-lifecycle>
      {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
        <KeyRound className="size-3.5" aria-hidden />{t.entitlements}
      </div>
      <div className="flex gap-2">
        <Select value={planId} onValueChange={(value) => setPlanId(value ?? "")}>
          <SelectTrigger className="min-w-0 flex-1"><SelectValue placeholder={t.pickEntitlementPlan} /></SelectTrigger>
          <SelectContent>{plans.map((plan) => <SelectItem key={plan.id} value={plan.id}>{plan.name}</SelectItem>)}</SelectContent>
        </Select>
        <Button size="sm" variant="outline" disabled={!planId || busy} onClick={() => void grant()}>{t.grantEntitlement}</Button>
      </div>
      {entitlements.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">{t.noEntitlements}</p> : (
        <div className="mt-2 space-y-2">{entitlements.map((row) => (
          <div key={row.id} className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-2.5 py-2 text-xs">
            <div className="min-w-0"><div className="truncate font-medium">{row.planName}</div><div className="text-[10px] text-muted-foreground">{row.planKey}</div></div>
            <Select value={row.status} disabled={busy} onValueChange={(value) => void changeEntitlement(row, value as CrmEntitlementStatus)}>
              <SelectTrigger className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{ENTITLEMENT_STATUSES.map((status) => <SelectItem key={status} value={status}>{t.entitlementStatusLabels[status]}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        ))}</div>
      )}

      <div className="mb-2 mt-4 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
        <CalendarCheck className="size-3.5" aria-hidden />{t.participation}
      </div>
      <div className="flex gap-2">
        <Select value={eventId} onValueChange={(value) => setEventId(value ?? "")}>
          <SelectTrigger className="min-w-0 flex-1"><SelectValue placeholder={t.pickEvent} /></SelectTrigger>
          <SelectContent>{events.map((event) => <SelectItem key={event.id} value={event.id}>{event.title}</SelectItem>)}</SelectContent>
        </Select>
        <Button size="sm" variant="outline" disabled={!eventId || busy} onClick={() => void register()}>{t.recordParticipation}</Button>
      </div>
      {participation.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">{t.noParticipation}</p> : (
        <div className="mt-2 space-y-2">{participation.map((row) => (
          <div key={row.id} className="rounded-lg border border-border/60 px-2.5 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0"><div className="truncate font-medium">{row.eventTitle}</div><div className="text-[10px] text-muted-foreground">{row.sourceKind}</div></div>
              <Select value={row.status} disabled={busy || row.commerceManaged} onValueChange={(value) => void changeParticipation(row, value as CrmParticipationStatus)}>
                <SelectTrigger className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{PARTICIPATION_STATUSES.map((status) => <SelectItem key={status} value={status}>{t.participationStatusLabels[status]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {row.commerceManaged && <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">{t.commerceManagedParticipation}</p>}
          </div>
        ))}</div>
      )}
    </section>
  );
}
