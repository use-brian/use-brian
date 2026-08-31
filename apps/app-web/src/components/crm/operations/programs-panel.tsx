"use client";

/** Addressable entitlement-plan and event catalog workspace. [COMP:app-web/crm-operations] */

import { useCallback, useEffect, useState } from "react";
import { CalendarDays, KeyRound } from "lucide-react";
import {
  listCrmEntitlementPlans,
  listCrmEntitlements,
  listCrmEvents,
  listCrmParticipation,
  type CrmEntitlement,
  type CrmEntitlementPlan,
  type CrmEvent,
  type CrmParticipation,
} from "@/lib/api/crm";
import { useT } from "@/lib/i18n/client";

export function CrmProgramsPanel({
  workspaceId,
  selectedPlanId,
  selectedEventId,
  onSelectPlan,
  onSelectEvent,
}: {
  workspaceId: string;
  selectedPlanId: string | null;
  selectedEventId: string | null;
  onSelectPlan: (id: string | null) => void;
  onSelectEvent: (id: string | null) => void;
}) {
  const t = useT().crmPage.operations;
  const [plans, setPlans] = useState<CrmEntitlementPlan[]>([]);
  const [events, setEvents] = useState<CrmEvent[]>([]);
  const [entitlements, setEntitlements] = useState<CrmEntitlement[]>([]);
  const [participation, setParticipation] = useState<CrmParticipation[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [nextPlans, nextEvents] = await Promise.all([
      listCrmEntitlementPlans(workspaceId, { limit: 100 }),
      listCrmEvents(workspaceId, { limit: 100 }),
    ]);
    setPlans(nextPlans); setEvents(nextEvents);
    if (!selectedPlanId && !selectedEventId) {
      if (nextPlans[0]) onSelectPlan(nextPlans[0].id);
      else if (nextEvents[0]) onSelectEvent(nextEvents[0].id);
    }
  }, [workspaceId, selectedPlanId, selectedEventId, onSelectPlan, onSelectEvent]);

  useEffect(() => { void load().catch(() => setError(t.lifecycleLoadFailed)); }, [load, t.lifecycleLoadFailed]);
  useEffect(() => {
    if (!selectedPlanId) { setEntitlements([]); return; }
    void listCrmEntitlements(workspaceId, { planId: selectedPlanId, limit: 100 })
      .then(setEntitlements).catch(() => setError(t.lifecycleLoadFailed));
  }, [workspaceId, selectedPlanId, t.lifecycleLoadFailed]);
  useEffect(() => {
    if (!selectedEventId) { setParticipation([]); return; }
    void listCrmParticipation(workspaceId, { eventId: selectedEventId, limit: 100 })
      .then(setParticipation).catch(() => setError(t.lifecycleLoadFailed));
  }, [workspaceId, selectedEventId, t.lifecycleLoadFailed]);

  const selectedPlan = plans.find((row) => row.id === selectedPlanId) ?? null;
  const selectedEvent = events.find((row) => row.id === selectedEventId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-1 max-md:flex-col" data-crm-programs-panel>
      <aside className="w-72 shrink-0 overflow-y-auto border-r border-border/60 max-md:w-full max-md:max-h-56 max-md:border-b max-md:border-r-0">
        <div className="border-b border-border/60 px-3 py-3 text-sm font-semibold">{t.programs}</div>
        <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"><KeyRound className="mr-1 inline size-3" />{t.entitlementPlans}</div>
        {plans.map((plan) => <button type="button" key={plan.id} className={`block w-full border-b border-border/40 px-3 py-2 text-left text-xs ${selectedPlanId === plan.id ? "bg-accent" : "hover:bg-accent/50"}`} onClick={() => { onSelectEvent(null); onSelectPlan(plan.id); }}><div className="font-medium">{plan.name}</div><div className="font-mono text-[10px] text-muted-foreground">{plan.planKey}</div></button>)}
        <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"><CalendarDays className="mr-1 inline size-3" />{t.events}</div>
        {events.map((event) => <button type="button" key={event.id} className={`block w-full border-b border-border/40 px-3 py-2 text-left text-xs ${selectedEventId === event.id ? "bg-accent" : "hover:bg-accent/50"}`} onClick={() => { onSelectPlan(null); onSelectEvent(event.id); }}><div className="font-medium">{event.title}</div><div className="font-mono text-[10px] text-muted-foreground">{event.slug}</div></button>)}
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-5">
        {error && <p className="mb-3 text-xs text-destructive">{error}</p>}
        {selectedPlan ? <>
          <h2 className="text-lg font-semibold">{selectedPlan.name}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t.planSummary.replace("{count}", String(entitlements.length))}</p>
          {selectedPlan.commerceManaged && <p className="mt-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{t.commerceManagedPlan}</p>}
          <div className="mt-4 divide-y divide-border/60">{entitlements.map((row) => <div key={row.id} className="flex justify-between gap-3 py-2 text-xs"><span>{row.contactName}</span><span>{t.entitlementStatusLabels[row.status]}</span></div>)}</div>
        </> : selectedEvent ? <>
          <h2 className="text-lg font-semibold">{selectedEvent.title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t.eventSummary.replace("{count}", String(participation.length))}</p>
          {selectedEvent.commerceManaged && <p className="mt-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{t.commerceManagedEvent}</p>}
          <div className="mt-4 divide-y divide-border/60">{participation.map((row) => <div key={row.id} className="flex justify-between gap-3 py-2 text-xs"><span>{row.contactName || row.attendeeName}</span><span>{t.participationStatusLabels[row.status]}</span></div>)}</div>
        </> : <p className="text-sm text-muted-foreground">{t.pickProgram}</p>}
      </main>
    </div>
  );
}
