"use client";

/** Record-scoped relationship timeline plus existing reviewed-email approvals. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, ChevronRight, Clock3, Mail, MessageSquarePlus, RefreshCw, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { parseToolPreview } from "@/lib/approval-previews";
import { listApprovals, type PendingApprovalRow } from "@/lib/api/approvals";
import {
  createCrmActivity,
  fetchCrmTimeline,
  listCrmDealParticipants,
  type CrmActivity,
  type CrmContactRow,
  type CrmData,
  type CrmDealParticipant,
} from "@/lib/api/crm";
import { linkedContactsForEmailApproval, matchingEmailApprovals, type CrmApprovalRecord } from "@/lib/crm-r2";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

export function CrmActivityTimeline({
  workspaceId,
  record,
  data,
  onOpenContact,
  onReviewEmail,
}: {
  workspaceId: string;
  record: CrmApprovalRecord;
  data: CrmData;
  onOpenContact: (contact: CrmContactRow) => void;
  onReviewEmail: (approvalId: string) => void;
}) {
  const t = useT().crmPage.r2;
  const [activities, setActivities] = useState<CrmActivity[]>([]);
  const [approvals, setApprovals] = useState<PendingApprovalRow[]>([]);
  const [participants, setParticipants] = useState<CrmDealParticipant[]>([]);
  const [loading, setLoading] = useState(true);
  const [activityError, setActivityError] = useState(false);
  const [approvalError, setApprovalError] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [activityType, setActivityType] = useState<"note" | "call" | "meeting" | "message">("note");
  const [direction, setDirection] = useState<"internal" | "inbound" | "outbound">("internal");
  const [subject, setSubject] = useState("");
  const [summary, setSummary] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setActivityError(false);
    setApprovalError(false);
    const [timeline, pending, participants] = await Promise.allSettled([
      fetchCrmTimeline(workspaceId, record.row.id),
      listApprovals(workspaceId, { throwOnError: true }),
      record.kind === "deal"
        ? listCrmDealParticipants(workspaceId, record.row.id)
        : Promise.resolve([]),
    ]);
    if (timeline.status === "fulfilled") setActivities(timeline.value);
    else setActivityError(true);
    if (pending.status === "fulfilled") setApprovals(pending.value);
    else setApprovalError(true);
    if (participants.status === "fulfilled") {
      setParticipants(participants.value);
    } else {
      setApprovalError(true);
    }
    setLoading(false);
  }, [workspaceId, record.row.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const emailApprovals = useMemo(
    () => matchingEmailApprovals(
      record,
      data,
      approvals,
      participants.flatMap((participant) => participant.email ? [participant.email] : []),
    ),
    [record, data, approvals, participants],
  );

  async function saveActivity() {
    if (!summary.trim() || saving) return;
    setSaving(true);
    setActivityError(false);
    try {
      const activity = await createCrmActivity(workspaceId, record.row.id, {
        activityType,
        direction,
        subject: subject.trim() || undefined,
        occurredAt: occurredAt ? new Date(occurredAt).toISOString() : undefined,
        summary: summary.trim(),
      });
      setActivities((current) => [activity, ...current]);
      setComposerOpen(false);
      setSubject("");
      setSummary("");
      setOccurredAt("");
    } catch {
      setActivityError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-4 border-t border-border/60 pt-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
          <Clock3 className="size-3.5" aria-hidden />
          {t.activityTitle}
        </div>
        <Button size="xs" variant="ghost" onClick={() => setComposerOpen((open) => !open)}>
          <MessageSquarePlus aria-hidden />
          {t.logActivity}
        </Button>
      </div>

      {composerOpen && (
        <div className="mb-3 space-y-2 rounded-xl border border-border bg-muted/20 p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Select value={activityType} onValueChange={(value) => setActivityType(value as typeof activityType)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(["note", "call", "meeting", "message"] as const).map((type) => (
                  <SelectItem key={type} value={type}>{t.activityType[type]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={direction} onValueChange={(value) => setDirection(value as typeof direction)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(["internal", "inbound", "outbound"] as const).map((value) => (
                  <SelectItem key={value} value={value}>{t.activityDirection[value]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder={t.activitySubject}
            className="h-8 w-full rounded-lg border border-border bg-background px-2.5 text-xs outline-none"
          />
          <textarea
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            placeholder={t.notePlaceholder}
            rows={4}
            className="w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-xs outline-none"
          />
          <label className="block text-[11px] text-muted-foreground">
            <span className="mb-1 block">{t.occurredAt}</span>
            <input
              type="datetime-local"
              value={occurredAt}
              onChange={(event) => setOccurredAt(event.target.value)}
              className="h-8 w-full rounded-lg border border-border bg-background px-2.5 text-xs text-foreground outline-none"
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="ghost" onClick={() => setComposerOpen(false)}>{t.cancel}</Button>
            <Button size="xs" disabled={saving || !summary.trim()} onClick={() => void saveActivity()}>{saving ? t.saving : t.saveActivity}</Button>
          </div>
        </div>
      )}

      {emailApprovals.length > 0 && (
        <div className="mb-3 space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Mail className="size-3.5" aria-hidden />
            {t.reviewedReplies}
          </div>
          {emailApprovals.map((approval) => (
            <CrmEmailApprovalSummary
              key={approval.id}
              row={approval}
              contacts={linkedContactsForEmailApproval(
                approval,
                record,
                data,
                participants.map((participant) => participant.contactId),
              )}
              onOpenContact={onOpenContact}
              onReview={() => onReviewEmail(approval.id)}
            />
          ))}
        </div>
      )}

      {approvalError && (
        <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span>{t.approvalsLoadFailed}</span>
          <Button size="xs" variant="ghost" onClick={() => void reload()}><RefreshCw aria-hidden />{t.retry}</Button>
        </div>
      )}

      {activityError ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span>{t.activityLoadFailed}</span>
          <Button size="xs" variant="ghost" onClick={() => void reload()}><RefreshCw aria-hidden />{t.retry}</Button>
        </div>
      ) : loading ? (
        <div className="text-xs text-muted-foreground">{t.activityLoading}</div>
      ) : activities.length === 0 ? (
        <div className="text-xs text-muted-foreground">{t.activityEmpty}</div>
      ) : (
        <ol className="space-y-2">
          {activities.map((activity) => (
            <li key={activity.id} className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <div className="flex items-start gap-2">
                {activity.direction === "inbound" ? (
                  <ArrowDownLeft className="mt-0.5 size-3.5 shrink-0 text-emerald-600" aria-hidden />
                ) : activity.direction === "outbound" ? (
                  <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-blue-600" aria-hidden />
                ) : (
                  <Clock3 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-xs font-medium">
                      {activity.subject || t.activityType[activity.activityType] || activity.activityType}
                    </span>
                    <time className="shrink-0 text-[10px] text-muted-foreground">
                      {new Date(activity.occurredAt).toLocaleString()}
                    </time>
                  </div>
                  {activity.summary && (
                    <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
                      {activity.summary}
                    </p>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function CrmEmailApprovalSummary({
  row,
  contacts,
  onOpenContact,
  onReview,
}: {
  row: PendingApprovalRow;
  contacts: CrmContactRow[];
  onOpenContact: (contact: CrmContactRow) => void;
  onReview: () => void;
}) {
  const t = useT().crmPage.r2;
  const preview = parseToolPreview(row.toolName, row.arguments);
  const email = preview?.kind === "email_send" ? preview.email : null;
  const revision = row.approvalPayload.emailDraftRevision ?? 1;

  return (
    <article className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-300">
          <Mail className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold">{email?.subject || t.reviewDraft}</div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {email?.to.join(", ")}
              </div>
            </div>
            <span className="shrink-0 rounded-full border border-amber-500/30 bg-background/80 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-200">
              {format(t.draftRevision, { number: revision })}
            </span>
          </div>

          {contacts.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {contacts.map((contact) => (
                <button
                  key={contact.id}
                  type="button"
                  onClick={() => onOpenContact(contact)}
                  className="inline-flex max-w-full items-center gap-1 rounded-full bg-background/80 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  <UserRound className="size-3" aria-hidden />
                  <span className="truncate">{contact.name}</span>
                </button>
              ))}
            </div>
          )}

          <Button size="xs" className="mt-3" onClick={onReview}>
            {t.openEmailReview}
            <ChevronRight aria-hidden />
          </Button>
        </div>
      </div>
    </article>
  );
}
