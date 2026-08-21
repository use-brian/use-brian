"use client";

/** Record-scoped relationship timeline plus existing reviewed-email approvals. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Building2, Check, Clock3, ExternalLink, Mail, MessageSquarePlus, Phone, RefreshCw, Tags, UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { extractEmailSender, parseToolPreview } from "@/lib/approval-previews";
import {
  fetchEmailReviewContext,
  listApprovals,
  respondByKind,
  reviseEmailApproval,
  type EmailReviewContext,
  type PendingApprovalRow,
} from "@/lib/api/approvals";
import { requestApprovalsRefresh } from "@/lib/approvals-events";
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
}: {
  workspaceId: string;
  record: CrmApprovalRecord;
  data: CrmData;
  onOpenContact: (contact: CrmContactRow) => void;
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
            <CrmEmailApproval
              key={approval.id}
              row={approval}
              entityId={record.row.id}
              contacts={linkedContactsForEmailApproval(
                approval,
                record,
                data,
                participants.map((participant) => participant.contactId),
              )}
              data={data}
              onOpenContact={onOpenContact}
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
  entityId,
  contacts,
  data,
  onOpenContact,
  onResolved,
  onRevised,
}: {
  row: PendingApprovalRow;
  entityId: string;
  contacts: CrmContactRow[];
  data: CrmData;
  onOpenContact: (contact: CrmContactRow) => void;
  onResolved: (id: string) => void;
  onRevised: (oldId: string, next: PendingApprovalRow) => void;
}) {
  const dictionary = useT();
  const t = dictionary.crmPage.r2;
  const emailT = dictionary.approvalsPage.emailPreview;
  const [busy, setBusy] = useState(false);
  const savedBody = typeof row.arguments.body === "string" ? row.arguments.body : "";
  const [body, setBody] = useState(savedBody);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<EmailReviewContext | null>(null);
  const [contextLoading, setContextLoading] = useState(true);
  const [contextError, setContextError] = useState(false);
  const preview = parseToolPreview(row.toolName, row.arguments);
  const email = preview?.kind === "email_send" ? preview.email : null;
  const sender = extractEmailSender(row.approvalPayload.displayLines)
    ?? email?.from
    ?? emailT.primaryAccount;
  const dirty = body !== savedBody;
  const revision = row.approvalPayload.emailDraftRevision ?? 1;

  const loadContext = useCallback(async () => {
    setContextLoading(true);
    setContextError(false);
    try {
      setContext(await fetchEmailReviewContext(row.id, entityId));
    } catch {
      setContextError(true);
    } finally {
      setContextLoading(false);
    }
  }, [row.id, entityId]);

  useEffect(() => {
    void loadContext();
  }, [loadContext]);

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
    }
  }

  return (
    <article className="overflow-hidden rounded-xl border border-amber-500/30 bg-amber-500/5">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/20 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Mail className="size-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold">{email?.subject || t.reviewDraft}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {sender} → {email?.to.join(", ")}
            </div>
          </div>
        </div>
        <span className="rounded-full border border-amber-500/30 bg-background/80 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-200">
          {format(t.draftRevision, { number: revision })}
        </span>
      </header>

      <div className="space-y-3 p-3">
        {contacts.length > 0 && (
          <section aria-label={t.linkedContact}>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t.linkedContact}</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {contacts.map((contact) => {
                const company = contact.companyId
                  ? data.companies.find((row) => row.id === contact.companyId)
                  : null;
                return (
                  <button
                    key={contact.id}
                    type="button"
                    onClick={() => onOpenContact(contact)}
                    className="group rounded-lg border border-border bg-background/80 p-2 text-left transition-colors hover:bg-accent/50"
                  >
                    <div className="flex items-center gap-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted"><UserRound className="size-3.5" aria-hidden /></span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1 text-xs font-medium">
                          <span className="truncate">{contact.name}</span>
                          <ExternalLink className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground">{contact.email}</div>
                      </div>
                    </div>
                    {(contact.phone || company || contact.tags.length > 0) && (
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                        {contact.phone && <span className="inline-flex items-center gap-1"><Phone className="size-3" aria-hidden />{contact.phone}</span>}
                        {company && <span className="inline-flex items-center gap-1"><Building2 className="size-3" aria-hidden />{company.name}</span>}
                        {contact.tags.length > 0 && <span className="inline-flex items-center gap-1"><Tags className="size-3" aria-hidden />{contact.tags.join(", ")}</span>}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <section aria-label={t.conversation}>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t.conversation}</div>
            {context?.thread?.truncated && <span className="text-[10px] text-muted-foreground">{t.conversationTruncated}</span>}
          </div>
          {contextLoading ? (
            <div className="rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-xs text-muted-foreground">{t.conversationLoading}</div>
          ) : contextError ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <span>{t.conversationLoadFailed}</span>
              <Button size="xs" variant="ghost" onClick={() => void loadContext()}><RefreshCw aria-hidden />{t.retry}</Button>
            </div>
          ) : !context?.thread ? (
            <div className="rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-xs text-muted-foreground">{t.conversationUnavailable}</div>
          ) : (
            <ol className="max-h-80 space-y-2 overflow-y-auto rounded-lg border border-border/70 bg-background/70 p-2">
              {context.thread.messages.map((message) => (
                <li key={`${message.folder}:${message.id}`} className="rounded-md border border-border/60 bg-background px-2.5 py-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[11px] font-medium">{message.from}</div>
                      <div className="truncate text-[10px] text-muted-foreground">{emailT.to}: {message.to.join(", ")}</div>
                      {message.cc.length > 0 && <div className="truncate text-[10px] text-muted-foreground">{emailT.cc}: {message.cc.join(", ")}</div>}
                    </div>
                    {message.sentAt && <time className="shrink-0 text-[10px] text-muted-foreground">{new Date(message.sentAt).toLocaleString()}</time>}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/85">{message.body}</p>
                  {message.bodyTruncated && <div className="mt-1 text-[10px] text-muted-foreground">{t.messageTruncated}</div>}
                </li>
              ))}
            </ol>
          )}
        </section>

        <section aria-label={t.reviewDraft}>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <label htmlFor={`crm-email-draft-${row.id}`} className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t.reviewDraft}</label>
            <span className={`text-[10px] ${dirty ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}>
              {dirty ? t.unsavedChanges : t.savedDraftReady}
            </span>
          </div>
          <div className="mb-2 grid gap-1 rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-[11px] sm:grid-cols-[4rem_1fr]">
            <span className="text-muted-foreground">{emailT.from}</span><span className="truncate">{sender}</span>
            <span className="text-muted-foreground">{emailT.to}</span><span className="truncate">{email?.to.join(", ")}</span>
            <span className="text-muted-foreground">{emailT.subject}</span><span className="font-medium">{email?.subject}</span>
          </div>
        <textarea
          id={`crm-email-draft-${row.id}`}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={9}
          className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none"
          aria-label={t.replyBody}
        />
        </section>

        {error && <div className="text-xs text-destructive">{error}</div>}
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {dirty && (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => setBody(savedBody)}>
              {t.discardChanges}
            </Button>
          )}
          <Button size="xs" variant="outline" disabled={busy || !dirty || body.trim().length === 0} onClick={() => void saveRevision()}>
            {busy && dirty ? t.saving : t.saveRevision}
          </Button>
          <Button size="xs" variant="destructive" disabled={busy} onClick={() => void respond("rejected")}>
            <X aria-hidden /> {t.rejectReply}
          </Button>
          <Button size="xs" disabled={busy || dirty} title={dirty ? t.saveBeforeApprove : undefined} onClick={() => void respond("approved")}>
            <Check aria-hidden /> {t.approveSend}
          </Button>
        </div>
        {dirty && <p className="text-right text-[10px] text-muted-foreground">{t.saveBeforeApprove}</p>}
      </div>
    </article>
  );
}
