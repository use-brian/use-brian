"use client";

/**
 * The deal record's Engagement panel: the delivery tracking (work status,
 * deadline, owner, participants) kept apart from the sales pipeline stage,
 * the governed engagement fields with "Propose change", the protected
 * commercial values (quoted, confirmed, outsource) when the viewer may see
 * them, billing requests with their review steps, the billed and unbilled
 * balance, and "Create next period" for recurring work.
 *
 * Tracking edits name the tracking version the user read and never carry a
 * fee. Protected values are written only by owners and admins, with evidence,
 * after a confirm. An absent or null amount reads "Not set", never zero.
 *
 * Spec: docs/architecture/features/crm-commercial-operations.md -> "Governed engagement and billing".
 * [COMP:app-web/crm-commercial-operations]
 */

import { useEffect, useState } from "react";
import { BriefcaseBusiness, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import type { CrmCommercialCommand } from "@/lib/api/crm-commercial";
import {
  CRM_COMMERCIAL_VALUE_KINDS,
  getCrmBillingBalance,
  getCrmEngagement,
  getCrmGovernance,
  listCrmBillingRequests,
  previewCrmRecurringSuccessors,
  type CrmBillingBalance,
  type CrmBillingRequest,
  type CrmCarryForward,
  type CrmCommercialValueKind,
  type CrmEngagement,
  type CrmEngagementChanges,
  type CrmGovernance,
  type CrmRecurringPreview,
} from "@/lib/api/crm-governed";
import { newCrmOperationId } from "@/lib/api/crm-references";
import { useT } from "@/lib/i18n/client";
import {
  CommercialInput,
  CommercialSelect,
  CommercialTextarea,
  IssueList,
  RefusalLine,
  UncertainWrite,
  isCalendarDate,
  useCommercialCommand,
} from "./commercial-shared";
import { ChangeRequestList, ProposeChangeForm } from "./change-requests";
import {
  BillingStateBadge,
  GovernedHeading,
  catalogLabel,
  describeGovernedRefusal,
  memberLabel,
  type GovernedCopy,
  type GovernedMember,
} from "./governed-shared";
import { formatInvoiceMoney } from "./invoice-preparation";

const NOT_SET = "__not_set__";
const DECIMAL_PATTERN = /^-?\d{1,18}(\.\d{1,6})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const CARRY_FORWARD: readonly CrmCarryForward[] = ["serviceCategory", "owner", "participants", "quotedFee"];

type Loaded = {
  engagement: CrmEngagement;
  governance: CrmGovernance | null;
  billing: CrmBillingRequest[];
  balance: CrmBillingBalance | null;
};

function Fact({ label, value, muted, field }: { label: string; value: string; muted?: boolean; field: string }) {
  return (
    <div className="min-w-0" data-engagement-field={field}>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className={`break-words ${muted ? "italic text-muted-foreground" : ""}`}>{value}</dd>
    </div>
  );
}

export function CrmDealEngagement({ workspaceId, dealId, canConfigure, currentUserId, members, onRecordChanged }: {
  workspaceId: string;
  dealId: string;
  /** The deal itself may have changed (a governed field applied directly, or a successor created). */
  onRecordChanged?: () => void;
  /** Owner or admin: sets protected commercial values. */
  canConfigure: boolean;
  currentUserId: string | null;
  members: readonly GovernedMember[];
}) {
  const g = useT().crmPage.governed;
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<"tracking" | "propose" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [requestsKey, setRequestsKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void Promise.all([
      getCrmEngagement(workspaceId, dealId),
      getCrmGovernance(workspaceId).catch(() => null),
      listCrmBillingRequests(workspaceId, { dealId }),
      getCrmBillingBalance(workspaceId, dealId).catch(() => null),
    ])
      .then(([engagement, governance, billing, balance]) => {
        if (cancelled) return;
        if (!engagement) { setFailed(true); return; }
        setData({ engagement, governance, billing, balance });
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [workspaceId, dealId, attempt]);

  useEffect(() => {
    setData(null);
    setMode(null);
    setNotice(null);
  }, [workspaceId, dealId]);

  const reload = () => setAttempt((value) => value + 1);

  return (
    <section className="mt-4 min-w-0 border-t border-border/60 pt-4" data-crm-deal-engagement>
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
        <BriefcaseBusiness className="size-3.5" aria-hidden />{g.engagementTitle}
      </div>
      {notice && <p role="status" className="mb-2 text-xs text-emerald-700 dark:text-emerald-300">{notice}</p>}
      {failed && !data ? (
        <div className="flex items-center justify-between gap-2 text-xs text-destructive">
          <span>{g.loadFailed}</span>
          <Button size="sm" variant="ghost" onClick={reload}>{g.retry}</Button>
        </div>
      ) : !data ? (
        <div className="text-xs text-muted-foreground">{g.loading}</div>
      ) : (
        <div className="min-w-0 space-y-4">
          <EngagementSummary engagement={data.engagement} governance={data.governance} members={members} />
          {mode === "tracking" ? (
            <TrackingEditor workspaceId={workspaceId} engagement={data.engagement} governance={data.governance} members={members}
              onCancel={() => { setMode(null); reload(); }}
              onSaved={() => { setMode(null); setNotice(g.trackingSaved); reload(); }} />
          ) : mode === "propose" ? (
            <ProposeChangeForm
              workspaceId={workspaceId}
              current={{
                kind: "deal",
                id: dealId,
                name: data.engagement.displayName,
                serviceCategory: data.engagement.serviceCategory,
                periodStart: data.engagement.periodStart,
                periodEnd: data.engagement.periodEnd,
                financialPeriod: data.engagement.financialPeriod,
              }}
              governance={data.governance}
              onCancel={() => setMode(null)}
              onDone={({ applied }) => {
                setMode(null);
                setNotice(applied ? g.appliedDirect : g.submittedForReview);
                setRequestsKey((value) => value + 1);
                reload();
                if (applied) onRecordChanged?.();
              }}
            />
          ) : (
            <div className="flex flex-wrap gap-2" data-engagement-actions>
              <Button size="sm" variant="outline" onClick={() => { setNotice(null); setMode("tracking"); }}>{g.editTracking}</Button>
              <Button size="sm" variant="outline" onClick={() => { setNotice(null); setMode("propose"); }}>{g.proposeChange}</Button>
            </div>
          )}
          <div>
            <GovernedHeading title={g.changeRequestsTitle} />
            <ChangeRequestList workspaceId={workspaceId} targetId={dealId} currentUserId={currentUserId} members={members}
              governance={data.governance} reloadKey={requestsKey} onChanged={() => { reload(); onRecordChanged?.(); }} />
          </div>
          <ProtectedValues workspaceId={workspaceId} engagement={data.engagement} canConfigure={canConfigure} onSaved={() => { setNotice(g.valuesSaved); reload(); }} />
          <BillingSection workspaceId={workspaceId} dealId={dealId} requests={data.billing} balance={data.balance}
            defaultCurrency={data.engagement.commercialValues?.find((value) => value.valueKind === "confirmed")?.currency ?? null}
            onChanged={reload} />
          <NextPeriod workspaceId={workspaceId} dealId={dealId} onCreated={() => onRecordChanged?.()} />
        </div>
      )}
    </section>
  );
}

function EngagementSummary({ engagement, governance, members }: {
  engagement: CrmEngagement;
  governance: CrmGovernance | null;
  members: readonly GovernedMember[];
}) {
  const g = useT().crmPage.governed;
  const workStatus = catalogLabel(governance, "work_status", engagement.workStatus);
  const category = catalogLabel(governance, "service_category", engagement.serviceCategory);
  const period = engagement.periodStart || engagement.periodEnd
    ? g.periodRange.replace("{start}", engagement.periodStart ?? g.notSet).replace("{end}", engagement.periodEnd ?? g.notSet)
    : null;
  const participants = engagement.participantIds.map((id) => memberLabel(members, id) ?? id);
  return (
    <div className="min-w-0">
      <p className="mb-2 text-[11px] text-muted-foreground">{g.workStatusHelp}</p>
      <dl className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-2 text-xs sm:grid-cols-2">
        <Fact field="workStatus" label={g.fields.workStatus} value={workStatus ?? g.notSet} muted={!workStatus} />
        <Fact field="pipelineStage" label={g.salesStage} value={engagement.pipelineStage ?? g.notSet} muted={!engagement.pipelineStage} />
        <Fact field="serviceCategory" label={g.fields.serviceCategory} value={category ?? g.notSet} muted={!category} />
        <Fact field="period" label={g.servicePeriod} value={period ?? g.notSet} muted={!period} />
        <Fact field="financialPeriod" label={g.fields.financialPeriod} value={engagement.financialPeriod ?? g.notSet} muted={!engagement.financialPeriod} />
        <Fact field="deadline" label={g.fields.deadline} value={engagement.deadline ?? g.notSet} muted={!engagement.deadline} />
        <Fact field="owner" label={g.fields.ownerUserId} value={memberLabel(members, engagement.ownerUserId) ?? g.notSet} muted={!engagement.ownerUserId} />
        <Fact field="participants" label={g.fields.participantIds} value={participants.length ? participants.join(", ") : g.notSet} muted={!participants.length} />
      </dl>
      {engagement.recurrencePeriodKey && (
        <p className="mt-2 text-[11px] text-muted-foreground">{g.recurrenceOf.replace("{period}", engagement.recurrencePeriodKey)}</p>
      )}
      {engagement.trackingVersion === 0 && <p className="mt-2 text-[11px] text-muted-foreground">{g.noTrackingYet}</p>}
    </div>
  );
}

function TrackingEditor({ workspaceId, engagement, governance, members, onSaved, onCancel }: {
  workspaceId: string;
  engagement: CrmEngagement;
  governance: CrmGovernance | null;
  members: readonly GovernedMember[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const g = useT().crmPage.governed;
  const commercial = useT().crmPage.commercial;
  const [workStatus, setWorkStatus] = useState(engagement.workStatus ?? NOT_SET);
  const [deadline, setDeadline] = useState(engagement.deadline ?? "");
  const [owner, setOwner] = useState(engagement.ownerUserId ?? NOT_SET);
  const [participants, setParticipants] = useState<string[]>(engagement.participantIds);
  const [refusal, setRefusal] = useState<string | null>(null);
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;

  const statuses = (governance?.catalogs.find((item) => item.catalog === "work_status")?.entries ?? [])
    .filter((entry) => !entry.archived || entry.key === engagement.workStatus);
  const memberIds = new Set(members.map((member) => member.userId));
  const participantOptions = [...members, ...engagement.participantIds.filter((id) => !memberIds.has(id)).map((id) => ({ userId: id, name: id }))];

  const tracking: CrmEngagementChanges = {};
  const nextStatus = workStatus === NOT_SET ? null : workStatus;
  if (nextStatus !== engagement.workStatus) tracking.workStatus = nextStatus;
  if ((deadline || null) !== engagement.deadline) tracking.deadline = deadline || null;
  const nextOwner = owner === NOT_SET ? null : owner;
  if (nextOwner !== engagement.ownerUserId) tracking.ownerUserId = nextOwner;
  const sameParticipants = participants.length === engagement.participantIds.length
    && participants.every((id) => engagement.participantIds.includes(id));
  if (!sameParticipants) tracking.participantIds = participants;
  const changed = Object.keys(tracking).length > 0;
  const issues = deadline && !isCalendarDate(deadline) ? [g.issues.deadline] : [];

  async function send(command: CrmCommercialCommand) {
    setRefusal(null);
    const outcome = await writer.run(command);
    if (outcome.ok) { onSaved(); return; }
    if (!outcome.error.uncertain) setRefusal(describeGovernedRefusal(outcome.error, g, commercial));
  }

  function submit() {
    if (!changed || issues.length || locked) return;
    void send({
      kind: "update_engagement_tracking",
      operationId: newCrmOperationId(),
      dealId: engagement.id,
      expectedVersion: engagement.trackingVersion,
      tracking,
    });
  }

  const toggle = (id: string) => setParticipants((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  return (
    <div className="min-w-0 space-y-3 rounded-lg bg-muted/30 p-3" data-engagement-tracking-editor>
      <div className="text-xs font-medium">{g.trackingTitle}</div>
      <p className="text-[11px] text-muted-foreground">{g.trackingHelp}</p>
      <fieldset disabled={locked} className="grid min-w-0 gap-2 sm:grid-cols-2">
        <CommercialSelect label={g.fields.workStatus} value={workStatus}
          options={[{ value: NOT_SET, label: g.notSet }, ...statuses.map((entry) => ({ value: entry.key, label: entry.label }))]}
          onChange={setWorkStatus} />
        <CommercialInput label={g.fields.deadline} type="date" value={deadline} onChange={setDeadline} />
        <CommercialSelect label={g.fields.ownerUserId} value={owner}
          options={[{ value: NOT_SET, label: g.notSet }, ...members.map((member) => ({ value: member.userId, label: member.name }))]}
          onChange={setOwner} />
        <div className="min-w-0 sm:col-span-2">
          <div className="mb-1 text-xs text-muted-foreground">{g.fields.participantIds}</div>
          {participantOptions.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{g.noMembers}</p>
          ) : (
            <div className="flex flex-wrap gap-1" data-tracking-participants>
              {participantOptions.map((member) => (
                <Button key={member.userId} size="xs" variant={participants.includes(member.userId) ? "default" : "outline"} className="max-md:min-h-11"
                  aria-pressed={participants.includes(member.userId)} onClick={() => toggle(member.userId)}>
                  {member.name}
                </Button>
              ))}
            </div>
          )}
        </div>
      </fieldset>
      {statuses.length === 0 && <p className="text-[11px] text-muted-foreground">{g.noWorkStatuses}</p>}
      <IssueList issues={issues} />
      <RefusalLine text={refusal} />
      <UncertainWrite writer={writer} onRetry={(command) => void send(command)} onDiscard={onCancel} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={writer.busy} onClick={onCancel}>{g.cancel}</Button>
        <Button size="sm" disabled={!changed || issues.length > 0 || locked} onClick={submit}>{writer.busy ? g.saving : g.saveTracking}</Button>
      </div>
    </div>
  );
}

type ValueDraft = { amount: string; currency: string };

function valueText(value: { amount: string | null; currency: string | null } | undefined, g: GovernedCopy): string {
  if (!value || value.amount === null) return g.notSet;
  return formatInvoiceMoney(value.amount, value.currency);
}

/**
 * The protected values. Shown only when the server returned values the viewer
 * may see; an owner or admin also sees unset kinds as "Not set" and may set
 * them with evidence.
 */
function ProtectedValues({ workspaceId, engagement, canConfigure, onSaved }: {
  workspaceId: string;
  engagement: CrmEngagement;
  canConfigure: boolean;
  onSaved: () => void;
}) {
  const g = useT().crmPage.governed;
  const commercial = useT().crmPage.commercial;
  const values = engagement.commercialValues ?? [];
  const byKind = new Map(values.map((value) => [value.valueKind, value]));
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<CrmCommercialValueKind, ValueDraft>>(() => initialDrafts());
  const [source, setSource] = useState("");
  const [reason, setReason] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;

  function initialDrafts(): Record<CrmCommercialValueKind, ValueDraft> {
    const result = {} as Record<CrmCommercialValueKind, ValueDraft>;
    for (const kind of CRM_COMMERCIAL_VALUE_KINDS) {
      const value = byKind.get(kind);
      result[kind] = { amount: value?.amount ?? "", currency: value?.currency ?? "" };
    }
    return result;
  }

  if (values.length === 0 && !canConfigure) return null;
  const kinds = canConfigure ? CRM_COMMERCIAL_VALUE_KINDS : CRM_COMMERCIAL_VALUE_KINDS.filter((kind) => byKind.has(kind));

  const changedKinds = CRM_COMMERCIAL_VALUE_KINDS.filter((kind) => {
    const current = byKind.get(kind);
    const draft = drafts[kind];
    return (draft.amount.trim() || null) !== (current?.amount ?? null)
      || (draft.amount.trim() !== "" && draft.currency.trim() !== (current?.currency ?? ""));
  });
  const issues: string[] = [];
  for (const kind of changedKinds) {
    const draft = drafts[kind];
    if (draft.amount.trim() && !DECIMAL_PATTERN.test(draft.amount.trim())) issues.push(g.issues.amount.replace("{kind}", g.valueKinds[kind]));
    if (draft.amount.trim() && !CURRENCY_PATTERN.test(draft.currency.trim())) issues.push(g.issues.currency.replace("{kind}", g.valueKinds[kind]));
  }
  if (!source.trim()) issues.push(g.issues.evidenceSource);
  if (!reason.trim()) issues.push(g.issues.evidenceReason);

  async function send(command: CrmCommercialCommand) {
    setRefusal(null);
    const outcome = await writer.run(command);
    if (outcome.ok) { setEditing(false); onSaved(); return; }
    if (!outcome.error.uncertain) setRefusal(describeGovernedRefusal(outcome.error, g, commercial));
  }

  async function save() {
    if (!changedKinds.length || issues.length || locked) return;
    const summary = changedKinds.map((kind) => {
      const draft = drafts[kind];
      const next = draft.amount.trim() ? formatInvoiceMoney(draft.amount.trim(), draft.currency.trim()) : g.notSet;
      return `${g.valueKinds[kind]}: ${valueText(byKind.get(kind), g)} -> ${next}`;
    }).join("; ");
    const confirmed = await confirmDialog({
      title: g.valuesConfirmTitle,
      description: g.valuesConfirmDescription.replace("{changes}", summary),
      confirmLabel: g.saveValues,
      cancelLabel: g.cancel,
    });
    if (!confirmed) return;
    void send({
      kind: "set_commercial_values",
      operationId: newCrmOperationId(),
      dealId: engagement.id,
      values: changedKinds.map((kind) => {
        const draft = drafts[kind];
        const current = byKind.get(kind);
        const amount = draft.amount.trim() || null;
        return {
          valueKind: kind,
          expectedVersion: current?.version ?? 0,
          amount,
          currency: (draft.currency.trim() || current?.currency || "HKD").toUpperCase(),
          rate: null,
        };
      }),
      evidence: { source: source.trim(), reason: reason.trim() },
    });
  }

  return (
    <div className="min-w-0" data-engagement-values>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <GovernedHeading title={g.valuesTitle} help={g.valuesHelp} />
        {canConfigure && !editing && (
          <Button size="xs" variant="outline" className="max-md:min-h-11" onClick={() => { setDrafts(initialDrafts()); setRefusal(null); setEditing(true); }}>{g.editValues}</Button>
        )}
      </div>
      <dl className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-3">
        {kinds.map((kind) => {
          const value = byKind.get(kind);
          return (
            <div key={kind} className="min-w-0" data-commercial-value={kind}>
              <dt className="text-[11px] text-muted-foreground">{g.valueKinds[kind]}</dt>
              <dd className={`tabular-nums ${!value || value.amount === null ? "italic text-muted-foreground" : ""}`}>{valueText(value, g)}</dd>
            </div>
          );
        })}
      </dl>
      {editing && (
        <div className="mt-2 min-w-0 space-y-3 rounded-lg bg-muted/30 p-3" data-engagement-values-editor>
          <p className="text-[11px] text-muted-foreground">{g.valuesEditHelp}</p>
          <fieldset disabled={locked} className="min-w-0 space-y-2">
            {CRM_COMMERCIAL_VALUE_KINDS.map((kind) => (
              <div key={kind} className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <CommercialInput label={g.valueAmount.replace("{kind}", g.valueKinds[kind])} value={drafts[kind].amount} maxLength={26}
                  onChange={(amount) => setDrafts((current) => ({ ...current, [kind]: { ...current[kind], amount: amount.trim() } }))} />
                <CommercialInput label={g.valueCurrency.replace("{kind}", g.valueKinds[kind])} value={drafts[kind].currency} maxLength={3}
                  onChange={(currency) => setDrafts((current) => ({ ...current, [kind]: { ...current[kind], currency: currency.trim().toUpperCase() } }))} />
              </div>
            ))}
            <div className="grid min-w-0 gap-2 sm:grid-cols-2">
              <CommercialInput label={g.evidenceSource} value={source} maxLength={200} onChange={setSource} />
              <CommercialInput label={g.evidenceReason} value={reason} maxLength={2000} onChange={setReason} />
            </div>
          </fieldset>
          {!changedKinds.length && <p className="text-[11px] text-muted-foreground">{g.noChanges}</p>}
          <IssueList issues={changedKinds.length ? issues : []} />
          <RefusalLine text={refusal} />
          <UncertainWrite writer={writer} onRetry={(command) => void send(command)} onDiscard={() => { setEditing(false); onSaved(); }} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={writer.busy} onClick={() => setEditing(false)}>{g.cancel}</Button>
            <Button size="sm" disabled={!changedKinds.length || issues.length > 0 || locked} onClick={() => void save()}>{writer.busy ? g.saving : g.saveValues}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function billingNotice(request: { state?: unknown; reviewStep?: unknown } | undefined, g: GovernedCopy): string {
  if (request?.state === "ready_to_bill") return g.billingReady;
  if (request?.state === "draft") return g.billingDraftSaved;
  if (request?.state === "review") {
    return g.billingInReview.replace("{step}", request.reviewStep === "finance" ? g.reviewSteps.finance : g.reviewSteps.reviewer);
  }
  return g.saved;
}

function BillingSection({ workspaceId, dealId, requests, balance, defaultCurrency, onChanged }: {
  workspaceId: string;
  dealId: string;
  requests: CrmBillingRequest[];
  balance: CrmBillingBalance | null;
  defaultCurrency: string | null;
  onChanged: () => void;
}) {
  const g = useT().crmPage.governed;
  const [form, setForm] = useState<{ request: CrmBillingRequest | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const row = balance?.deals.find((deal) => deal.dealId === dealId) ?? null;

  return (
    <div className="min-w-0 space-y-2" data-engagement-billing>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <GovernedHeading title={g.billingTitle} help={g.billingHelp} />
        {!form && (
          <Button size="xs" variant="outline" className="max-md:min-h-11" onClick={() => { setNotice(null); setForm({ request: null }); }}>
            <Plus aria-hidden />{g.newBillingRequest}
          </Button>
        )}
      </div>
      {balance && (
        <dl className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-3" data-billing-balance>
          <div className="min-w-0">
            <dt className="text-[11px] text-muted-foreground">{g.confirmedFee}</dt>
            <dd className={row?.confirmedFee ? "tabular-nums" : "italic text-muted-foreground"}>
              {row?.confirmedFee ? formatInvoiceMoney(row.confirmedFee.amount, row.confirmedFee.currency) : g.noConfirmedFee}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[11px] text-muted-foreground">{g.billed}</dt>
            <dd className="tabular-nums">
              {row && row.billed.length ? row.billed.map((item) => formatInvoiceMoney(item.amount, item.currency)).join(", ") : g.nothingBilled}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[11px] text-muted-foreground">{g.unbilled}</dt>
            <dd className={row?.unbilled ? "tabular-nums" : "italic text-muted-foreground"} data-billing-unbilled>
              {row?.unbilled ? formatInvoiceMoney(row.unbilled.amount, row.unbilled.currency) : g.noConfirmedFee}
            </dd>
          </div>
        </dl>
      )}
      {notice && <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">{notice}</p>}
      {form && (
        <BillingRequestForm workspaceId={workspaceId} dealId={dealId} request={form.request} defaultCurrency={defaultCurrency}
          onCancel={() => setForm(null)}
          onSaved={(message) => { setForm(null); setNotice(message); onChanged(); }} />
      )}
      {requests.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{g.noBillingRequests}</p>
      ) : (
        <ul className="divide-y divide-border/60" data-billing-requests>
          {requests.map((request) => (
            <BillingRequestRow key={request.id} workspaceId={workspaceId} request={request}
              onRevise={() => { setNotice(null); setForm({ request }); }}
              onChanged={(message) => { setNotice(message); onChanged(); }} />
          ))}
        </ul>
      )}
    </div>
  );
}

function BillingRequestForm({ workspaceId, dealId, request, defaultCurrency, onSaved, onCancel }: {
  workspaceId: string;
  dealId: string;
  request: CrmBillingRequest | null;
  defaultCurrency: string | null;
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const g = useT().crmPage.governed;
  const commercial = useT().crmPage.commercial;
  const [amount, setAmount] = useState(request?.amount ?? "");
  const [currency, setCurrency] = useState(request?.currency ?? defaultCurrency ?? "HKD");
  const [description, setDescription] = useState(request?.description ?? "");
  const [refusal, setRefusal] = useState<string | null>(null);
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;

  const issues: string[] = [];
  if (!DECIMAL_PATTERN.test(amount.trim()) || amount.trim().startsWith("-")) issues.push(g.issues.billingAmount);
  if (!CURRENCY_PATTERN.test(currency.trim())) issues.push(g.issues.billingCurrency);
  if (!description.trim()) issues.push(g.issues.description);

  async function send(command: CrmCommercialCommand) {
    setRefusal(null);
    const outcome = await writer.run(command);
    if (outcome.ok) {
      const record = outcome.result.record as { request?: { state?: unknown; reviewStep?: unknown } } | null;
      onSaved(billingNotice(record?.request, g));
      return;
    }
    if (!outcome.error.uncertain) setRefusal(describeGovernedRefusal(outcome.error, g, commercial));
  }

  function submit(submitForReview: boolean) {
    if (issues.length || locked) return;
    void send({
      kind: "create_billing_request",
      operationId: newCrmOperationId(),
      dealId,
      amount: amount.trim(),
      currency: currency.trim().toUpperCase(),
      description: description.trim(),
      submit: submitForReview,
      ...(request ? { requestId: request.id, expectedVersion: request.version } : {}),
    });
  }

  return (
    <div className="min-w-0 space-y-3 rounded-lg bg-muted/30 p-3" data-billing-request-form={request ? "revise" : "create"}>
      <div className="text-xs font-medium">{request ? g.reviseBillingTitle : g.newBillingTitle}</div>
      <p className="text-[11px] text-muted-foreground">{g.billingFormHelp}</p>
      <fieldset disabled={locked} className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <CommercialInput label={g.billingAmount} value={amount} maxLength={26} onChange={(value) => setAmount(value.trim())} />
        <CommercialInput label={g.billingCurrency} value={currency} maxLength={3} onChange={(value) => setCurrency(value.trim().toUpperCase())} />
        <div className="sm:col-span-2">
          <CommercialTextarea label={g.billingDescription} value={description} maxLength={2000} onChange={setDescription} />
        </div>
      </fieldset>
      <IssueList issues={issues} />
      <RefusalLine text={refusal} />
      <UncertainWrite writer={writer} onRetry={(command) => void send(command)} onDiscard={onCancel} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={writer.busy} onClick={onCancel}>{g.cancel}</Button>
        <Button size="sm" variant="outline" disabled={issues.length > 0 || locked} onClick={() => submit(false)}>{g.saveDraft}</Button>
        <Button size="sm" disabled={issues.length > 0 || locked} onClick={() => submit(true)}>{writer.busy ? g.saving : g.submitForReview}</Button>
      </div>
    </div>
  );
}

function BillingRequestRow({ workspaceId, request, onRevise, onChanged }: {
  workspaceId: string;
  request: CrmBillingRequest;
  onRevise: () => void;
  onChanged: (message: string) => void;
}) {
  const g = useT().crmPage.governed;
  const commercial = useT().crmPage.commercial;
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;
  const revisable = request.state === "draft" || request.state === "returned";
  const cancellable = request.state !== "invoiced" && request.state !== "cancelled";

  async function send(command: CrmCommercialCommand) {
    setRefusal(null);
    const outcome = await writer.run(command);
    if (outcome.ok) {
      const record = outcome.result.record as { request?: { state?: unknown; reviewStep?: unknown } } | null;
      setCancelling(false);
      onChanged(command.kind === "cancel_billing_request" ? g.billingCancelled : billingNotice(record?.request, g));
      return;
    }
    if (!outcome.error.uncertain) setRefusal(describeGovernedRefusal(outcome.error, g, commercial));
  }

  async function cancel() {
    if (!reason.trim() || locked) return;
    const confirmed = await confirmDialog({
      title: g.cancelBillingConfirmTitle,
      description: g.cancelBillingConfirmDescription,
      confirmLabel: g.cancelBilling,
      cancelLabel: g.cancel,
      variant: "destructive",
    });
    if (!confirmed) return;
    await send({ kind: "cancel_billing_request", operationId: newCrmOperationId(), requestId: request.id, expectedVersion: request.version, reason: reason.trim() });
  }

  return (
    <li className="min-w-0 py-2 text-xs" data-billing-request={request.id}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="tabular-nums font-medium">{formatInvoiceMoney(request.amount, request.currency)}</span>
        <BillingStateBadge state={request.state} step={request.reviewStep} />
        <div className="ml-auto flex flex-wrap gap-1">
          {request.state === "draft" && (
            <Button size="xs" variant="outline" className="max-md:min-h-11" disabled={locked}
              onClick={() => void send({
                kind: "create_billing_request", operationId: newCrmOperationId(), dealId: request.dealId, amount: request.amount,
                currency: request.currency, description: request.description, submit: true, requestId: request.id, expectedVersion: request.version,
              })}>
              {g.submitForReview}
            </Button>
          )}
          {revisable && <Button size="xs" variant="ghost" className="max-md:min-h-11" disabled={locked} onClick={onRevise}>{g.revise}</Button>}
          {cancellable && !cancelling && (
            <Button size="xs" variant="ghost" className="max-md:min-h-11" disabled={locked} onClick={() => setCancelling(true)}>{g.cancelBilling}</Button>
          )}
        </div>
      </div>
      <p className="mt-0.5 break-words text-muted-foreground">{request.description}</p>
      {request.returnReason && request.state === "returned" && (
        <p className="mt-0.5 break-words text-[11px] text-amber-700 dark:text-amber-300">{g.returnedBecause.replace("{reason}", request.returnReason)}</p>
      )}
      {cancelling && (
        <div className="mt-2 space-y-2">
          <CommercialTextarea label={g.cancelReason} value={reason} maxLength={2000} onChange={setReason} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={writer.busy} onClick={() => setCancelling(false)}>{g.cancel}</Button>
            <Button size="sm" variant="destructive" disabled={locked || !reason.trim()} onClick={() => void cancel()}>{g.cancelBilling}</Button>
          </div>
        </div>
      )}
      <RefusalLine text={refusal} />
      <UncertainWrite writer={writer} onRetry={(command) => void send(command)} onDiscard={() => onChanged(g.saved)} />
    </li>
  );
}

type Outcome = { sourceDealId: string; outcome: "created" | "existing" | "stale"; dealId?: string; reason?: string };

function staleReason(reason: string | undefined, g: GovernedCopy): string {
  return reason && reason in g.staleReasons ? g.staleReasons[reason as keyof GovernedCopy["staleReasons"]] : g.staleReasons.source_unavailable;
}

/** Preview, then commit, the next period of this recurring engagement. Outcomes are reported exactly as the server returned them. */
function NextPeriod({ workspaceId, dealId, onCreated }: { workspaceId: string; dealId: string; onCreated: () => void }) {
  const g = useT().crmPage.governed;
  const commercial = useT().crmPage.commercial;
  const [open, setOpen] = useState(false);
  const [periodKey, setPeriodKey] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [financialPeriod, setFinancialPeriod] = useState("");
  const [deadline, setDeadline] = useState("");
  const [carry, setCarry] = useState<CrmCarryForward[]>(["serviceCategory", "owner", "participants"]);
  const [preview, setPreview] = useState<CrmRecurringPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;

  const issues: string[] = [];
  if (!periodKey.trim()) issues.push(g.issues.periodKey);
  if (!isCalendarDate(periodStart) || !isCalendarDate(periodEnd) || periodEnd < periodStart) issues.push(g.issues.period);
  if (deadline && !isCalendarDate(deadline)) issues.push(g.issues.deadline);
  const previewFor = preview && preview.periodKey === periodKey.trim() ? preview : null;
  const creatable = previewFor?.candidates.some((candidate) => candidate.outcome === "create") ?? false;

  async function runPreview() {
    if (!periodKey.trim() || previewing) return;
    setPreviewing(true);
    setPreviewError(null);
    setOutcomes(null);
    try {
      setPreview(await previewCrmRecurringSuccessors(workspaceId, { sourceDealIds: [dealId], periodKey: periodKey.trim() }));
    } catch {
      setPreview(null);
      setPreviewError(g.previewFailed);
    } finally {
      setPreviewing(false);
    }
  }

  async function send(command: CrmCommercialCommand) {
    setRefusal(null);
    const outcome = await writer.run(command);
    if (outcome.ok) {
      const record = outcome.result.record as { outcomes?: Outcome[] } | null;
      const reported = Array.isArray(record?.outcomes) ? record.outcomes : [];
      setOutcomes(reported);
      setPreview(null);
      if (reported.some((item) => item.outcome === "created")) onCreated();
      return;
    }
    if (!outcome.error.uncertain) setRefusal(describeGovernedRefusal(outcome.error, g, commercial));
  }

  async function commit() {
    if (!creatable || issues.length || locked) return;
    const confirmed = await confirmDialog({
      title: g.nextPeriodConfirmTitle.replace("{period}", periodKey.trim()),
      description: g.nextPeriodConfirmDescription,
      confirmLabel: g.createNextPeriod,
      cancelLabel: g.cancel,
    });
    if (!confirmed) return;
    await send({
      kind: "commit_recurring_successors",
      operationId: newCrmOperationId(),
      sourceDealIds: [dealId],
      period: {
        key: periodKey.trim(),
        periodStart,
        periodEnd,
        financialPeriod: financialPeriod.trim() || null,
        deadline: deadline || null,
      },
      carryForward: carry,
    });
  }

  const toggle = (item: CrmCarryForward) => setCarry((current) => current.includes(item) ? current.filter((value) => value !== item) : [...current, item]);

  return (
    <div className="min-w-0" data-engagement-next-period>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <GovernedHeading title={g.nextPeriodTitle} help={g.nextPeriodHelp} />
        <Button size="xs" variant={open ? "secondary" : "outline"} className="max-md:min-h-11" aria-pressed={open} onClick={() => setOpen((value) => !value)}>
          {g.createNextPeriod}
        </Button>
      </div>
      {open && (
        <div className="mt-2 min-w-0 space-y-3 rounded-lg bg-muted/30 p-3">
          <fieldset disabled={locked} className="grid min-w-0 gap-2 sm:grid-cols-2">
            <CommercialInput label={g.periodKey} value={periodKey} maxLength={40} onChange={setPeriodKey} />
            <CommercialInput label={g.fields.financialPeriod} value={financialPeriod} maxLength={40} onChange={setFinancialPeriod} />
            <CommercialInput label={g.fields.periodStart} type="date" value={periodStart} onChange={setPeriodStart} />
            <CommercialInput label={g.fields.periodEnd} type="date" value={periodEnd} onChange={setPeriodEnd} />
            <CommercialInput label={g.fields.deadline} type="date" value={deadline} onChange={setDeadline} />
            <div className="min-w-0 sm:col-span-2">
              <div className="mb-1 text-xs text-muted-foreground">{g.carryForward}</div>
              <div className="flex flex-wrap gap-1">
                {CARRY_FORWARD.map((item) => (
                  <Button key={item} size="xs" variant={carry.includes(item) ? "default" : "outline"} className="max-md:min-h-11"
                    aria-pressed={carry.includes(item)} onClick={() => toggle(item)}>
                    {g.carryLabels[item]}
                  </Button>
                ))}
              </div>
            </div>
          </fieldset>
          <IssueList issues={issues} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" disabled={!periodKey.trim() || previewing || locked} onClick={() => void runPreview()}>
              {previewing ? g.previewing : g.preview}
            </Button>
            <Button size="sm" disabled={!creatable || issues.length > 0 || locked} onClick={() => void commit()}>{g.createNextPeriod}</Button>
          </div>
          <RefusalLine text={previewError ?? refusal} />
          <UncertainWrite writer={writer} onRetry={(command) => void send(command)} onDiscard={() => setPreview(null)} />
          {previewFor && (
            <ul className="space-y-1 text-xs" data-next-period-preview>
              {previewFor.candidates.map((candidate) => (
                <li key={candidate.sourceDealId} data-preview-outcome={candidate.outcome} className="break-words">
                  {candidate.outcome === "create"
                    ? g.previewCreate.replace("{name}", candidate.proposedName ?? "")
                    : candidate.outcome === "existing"
                      ? g.previewExisting
                      : g.previewStale.replace("{reason}", staleReason(candidate.reason, g))}
                </li>
              ))}
            </ul>
          )}
          {outcomes && (
            <ul className="space-y-1 text-xs" data-next-period-outcomes>
              {outcomes.length === 0 && <li>{g.outcomeNone}</li>}
              {outcomes.map((outcome) => (
                <li key={outcome.sourceDealId} data-commit-outcome={outcome.outcome} className="break-words">
                  {outcome.outcome === "created"
                    ? g.outcomeCreated
                    : outcome.outcome === "existing"
                      ? g.outcomeExisting
                      : g.outcomeStale.replace("{reason}", staleReason(outcome.reason, g))}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
