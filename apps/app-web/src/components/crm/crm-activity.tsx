"use client";

/** Record-scoped relationship timeline plus existing reviewed-email approvals. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Check, Clock3, Mail, MessageSquarePlus, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToolPreview } from "@/components/doc/panels/approval-tool-previews";
import { parseToolPreview } from "@/lib/approval-previews";
import {
  listApprovals,
  respondByKind,
  reviseEmailApproval,
  type PendingApprovalRow,
} from "@/lib/api/approvals";
import { requestApprovalsRefresh } from "@/lib/approvals-events";
import {
  createCrmActivity,
  fetchCrmTimeline,
  listCrmDealParticipants,
  type CrmActivity,
  type CrmData,
} from "@/lib/api/crm";
import { matchingEmailApprovals, type CrmApprovalRecord } from "@/lib/crm-r2";
import { useT } from "@/lib/i18n/client";

export function CrmActivityTimeline({
  workspaceId,
  record,
  data,
}: {
  workspaceId: string;
  record: CrmApprovalRecord;
  data: CrmData;
}) {
  const t = useT().crmPage.r2;
  const [activities, setActivities] = useState<CrmActivity[]>([]);
  const [approvals, setApprovals] = useState<PendingApprovalRow[]>([]);
  const [participantEmails, setParticipantEmails] = useState<string[]>([]);
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
      listApprovals(workspaceId),
      record.kind === "deal"
        ? listCrmDealParticipants(workspaceId, record.row.id)
        : Promise.resolve([]),
    ]);
    if (timeline.status === "fulfilled") setActivities(timeline.value);
    else setActivityError(true);
    if (pending.status === "fulfilled") setApprovals(pending.value);
    else setApprovalError(true);
    if (participants.status === "fulfilled") {
      setParticipantEmails(participants.value.flatMap((participant) => participant.email ? [participant.email] : []));
    } else {
      setApprovalError(true);
    }
    setLoading(false);
  }, [workspaceId, record.row.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const emailApprovals = useMemo(
    () => matchingEmailApprovals(record, data, approvals, participantEmails),
    [record, data, approvals, participantEmails],
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
            <CrmEmailApproval
              key={approval.id}
              row={approval}
              workspaceId={workspaceId}
              onResolved={(id) => {
                setApprovals((current) => current.filter((row) => row.id !== id));
                requestApprovalsRefresh(workspaceId);
              }}
              onRevised={(oldId, next) => {
                setApprovals((current) => current.map((row) => row.id === oldId ? next : row));
                requestApprovalsRefresh(workspaceId);
              }}
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

function CrmEmailApproval({
  row,
  workspaceId,
  onResolved,
  onRevised,
}: {
  row: PendingApprovalRow;
  workspaceId: string;
  onResolved: (id: string) => void;
  onRevised: (oldId: string, next: PendingApprovalRow) => void;
}) {
  const t = useT().crmPage.r2;
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(typeof row.arguments.body === "string" ? row.arguments.body : "");
  const [error, setError] = useState<string | null>(null);
  const preview = parseToolPreview(row.toolName, { ...row.arguments, body });

  async function respond(decision: "approved" | "rejected") {
    setBusy(true);
    setError(null);
    const result = await respondByKind(row, decision);
    if (result.ok) onResolved(row.id);
    else {
      setError("error" in result ? result.error : t.approvalFailed);
      setBusy(false);
    }
  }

  async function saveRevision() {
    setBusy(true);
    setError(null);
    const result = await reviseEmailApproval(row.id, body);
    setBusy(false);
    if (!result.ok) setError(result.error);
    else {
      onRevised(row.id, result.approval);
      setEditing(false);
    }
  }

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-2.5">
      {preview && !editing ? (
        <ToolPreview
          preview={preview}
          attachmentLines={row.approvalPayload.displayLines ?? []}
        />
      ) : (
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={6}
          className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none"
          aria-label={t.replyBody}
        />
      )}
      {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
      <div className="mt-2 flex flex-wrap justify-end gap-1.5">
        {editing ? (
          <>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              {t.cancel}
            </Button>
            <Button size="xs" disabled={busy || body.trim().length === 0} onClick={() => void saveRevision()}>
              {t.saveRevision}
            </Button>
          </>
        ) : (
          <>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
              {t.editReply}
            </Button>
            <Button size="xs" variant="destructive" disabled={busy} onClick={() => void respond("rejected")}>
              <X aria-hidden /> {t.rejectReply}
            </Button>
            <Button size="xs" disabled={busy} onClick={() => void respond("approved")}>
              <Check aria-hidden /> {t.approveSend}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
