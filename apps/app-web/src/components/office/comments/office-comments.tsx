"use client";

/** Semantic/spatial Office comments with range anchors and task workflows. [COMP:app-web/office-comments] */
import { useEffect, useState } from "react";
import { APP_LEVEL_ASSISTANT_ID } from "@use-brian/shared";
import { createOfficeComment, listOfficeComments, reactOfficeComment, replyOfficeComment, resolveOfficeComment, updateOfficeCommentThread, waitForOfficeJob, type OfficeCommentThread } from "@/lib/office/api";
import { useT } from "@/lib/i18n/client";
import { appendOfflineCommand, listOfflineJournal, removeOfflineJournalEntry } from "@/lib/office/offline";
import { CommentComposer } from "@/components/doc/comment-composer";
import { listWorkspaceMembers } from "@/lib/api/mentions";
import { SearchableSelect, type SearchableSelectItem } from "@/components/ui/searchable-select";

type OfficeCommentsProps = {
  artifactId: string;
  workspaceId: string;
  version: number;
  targetIds: string[];
  selectionAnchor?: OfficeCommentThread["anchor"] | null;
  anchorKind?: OfficeCommentThread["anchor"]["kind"];
  canComment: boolean;
  offline?: boolean;
  initialThreads?: OfficeCommentThread[];
  onRevisionCompleted?(): void | Promise<void>;
  onThreadsChange?(threads: OfficeCommentThread[]): void;
};

export function OfficeComments({ artifactId, workspaceId, version, targetIds, selectionAnchor, anchorKind = "object", canComment, offline = false, initialThreads, onRevisionCompleted, onThreadsChange }: OfficeCommentsProps) {
  const t = useT().office;
  const [threads, setThreads] = useState<OfficeCommentThread[]>(initialThreads ?? []);
  const [body, setBody] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [replying, setReplying] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [replyMentions, setReplyMentions] = useState<string[]>([]);
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const [memberItems, setMemberItems] = useState<SearchableSelectItem[]>([]);
  const [busy, setBusy] = useState(false);
  const setVisibleThreads = (next: OfficeCommentThread[]) => { setThreads(next); onThreadsChange?.(next); };
  const reload = () => listOfficeComments(artifactId).then(setVisibleThreads).catch(() => setVisibleThreads([]));
  useEffect(() => { if (offline) setVisibleThreads(initialThreads ?? []); else void reload(); }, [artifactId, offline, initialThreads]);
  useEffect(() => { void listWorkspaceMembers(workspaceId).then((rows) => setMemberItems(rows.map((member) => ({ value: member.id, label: member.name, hint: member.email ?? undefined })))); }, [workspaceId]);
  useEffect(() => {
    if (offline) return;
    void listOfflineJournal(artifactId).then(async (entries) => {
      for (const entry of entries) {
        if (entry.kind !== "comment") continue;
        await createOfficeComment({ artifactId, anchor: entry.anchor as OfficeCommentThread["anchor"], body: entry.body, mentions: entry.mentions, invokeBrian: entry.invokeBrian });
        await removeOfflineJournalEntry(entry);
      }
      if (entries.some((entry) => entry.kind === "comment")) await reload();
    }).catch(() => undefined);
  }, [artifactId, offline]);

  const anchor = selectionAnchor ?? (targetIds.length ? { kind: anchorKind, targetIds } : null);

  async function submit() {
    if (!body.trim() || !anchor) return;
    setBusy(true);
    const invoke = /(^|\s)@Brian\b/i.test(body);
    try {
      const invokeBrian = invoke ? { assistantId: APP_LEVEL_ASSISTANT_ID, expectedVersion: version, idempotencyKey: crypto.randomUUID() } : undefined;
      if (offline) {
        const createdAt = new Date().toISOString();
        const seq = Date.now() * 1_000 + Math.floor(Math.random() * 1_000);
        await appendOfflineCommand({ artifactId, seq, kind: "comment", anchor, body: body.trim(), mentions, invokeBrian, createdAt });
        setThreads((current) => [...current, { id: `offline:${seq}`, artifactVersionId: String(version), anchorKind: anchor.kind, anchor, status: "open", messages: [{ id: `offline-message:${seq}`, authorType: "user", body: body.trim(), mentions, createdAt }] }]);
      } else {
        const created = await createOfficeComment({ artifactId, anchor, body: body.trim(), mentions, invokeBrian });
        if (created.revision && typeof created.revision === "object") {
          const job = await waitForOfficeJob(created.revision.jobId);
          if (job.status === "completed") await onRevisionCompleted?.();
        }
      }
      setBody(""); setMentions([]);
      if (!offline) await reload();
    } finally { setBusy(false); }
  }

  async function sendReply(threadId: string) {
    if (!replyBody.trim()) return;
    setBusy(true);
    try { await replyOfficeComment(threadId, replyBody.trim(), replyMentions); setReplyBody(""); setReplyMentions([]); setReplying(null); await reload(); } finally { setBusy(false); }
  }

  async function assign(thread: OfficeCommentThread, value: string) {
    await updateOfficeCommentThread(thread.id, { assignedUserId: value !== "brian" && value !== "unassigned" ? value : null, assignedToBrian: value === "brian", dueAt: thread.dueAt ?? null });
    await reload();
  }

  const visible = threads.filter((thread) => thread.status === filter || (filter === "open" && thread.status === "detached"));
  const assignees = [{ value: "unassigned", label: t.unassigned }, { value: "brian", label: t.brian }, ...memberItems];
  return <section aria-label={t.comments} className="space-y-4">
    <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">{t.comments}</h2><div className="flex gap-1"><button type="button" aria-pressed={filter === "open"} onClick={() => setFilter("open")} className="rounded px-2 py-1 text-xs aria-pressed:bg-muted">{t.open}</button><button type="button" aria-pressed={filter === "resolved"} onClick={() => setFilter("resolved")} className="rounded px-2 py-1 text-xs aria-pressed:bg-muted">{t.resolved}</button></div></div>
    <div className="max-h-96 space-y-3 overflow-y-auto">{visible.map((thread) => <article key={thread.id} className="rounded-lg border p-3" data-comment-status={thread.status}>
      <div className="space-y-2">{thread.messages.map((message) => <div key={message.id}><p className="text-sm">{message.body}</p>{canComment && !offline ? <div className="mt-1 flex gap-1"><ReactionButton label={t.thumbsUp} active={Boolean(message.reactions?.thumbs_up?.length)} onClick={() => void reactOfficeComment(message.id, "thumbs_up", !message.reactions?.thumbs_up?.length).then(reload)}>👍</ReactionButton><ReactionButton label={t.heart} active={Boolean(message.reactions?.heart?.length)} onClick={() => void reactOfficeComment(message.id, "heart", !message.reactions?.heart?.length).then(reload)}>♥</ReactionButton><ReactionButton label={t.check} active={Boolean(message.reactions?.check?.length)} onClick={() => void reactOfficeComment(message.id, "check", !message.reactions?.check?.length).then(reload)}>✓</ReactionButton></div> : null}</div>)}</div>
      <div className="mt-2 space-y-2">
        {canComment && !offline && thread.status !== "detached" ? <><SearchableSelect value={thread.assignedToBrian ? "brian" : thread.assignedUserId ?? "unassigned"} onValueChange={(value) => void assign(thread, value)} items={assignees} placeholder={t.assignComment} searchPlaceholder={t.searchMembers} emptyMessage={t.noMembers} aria-label={t.assignComment} className="h-8 text-xs" /><label className="block text-xs text-muted-foreground">{t.dueDate}<input type="date" value={thread.dueAt?.slice(0, 10) ?? ""} onChange={(event) => void updateOfficeCommentThread(thread.id, { assignedUserId: thread.assignedUserId ?? null, assignedToBrian: thread.assignedToBrian ?? false, dueAt: event.target.value ? `${event.target.value}T00:00:00.000Z` : null }).then(reload)} className="mt-1 h-8 w-full rounded border bg-background px-2" /></label></> : null}
        <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{thread.status === "detached" ? t.detachedComment : thread.status === "resolved" ? t.resolved : t.open}</span>{thread.status !== "detached" && canComment && !offline ? <div className="flex gap-2"><button type="button" onClick={() => setReplying(replying === thread.id ? null : thread.id)} className="hover:underline">{t.reply}</button><button type="button" onClick={() => void resolveOfficeComment(thread.id, thread.status !== "resolved").then(reload)} className="hover:underline">{thread.status === "resolved" ? t.reopen : t.resolve}</button></div> : null}</div>
        {replying === thread.id ? <div className="rounded border p-2"><CommentComposer value={replyBody} onValueChange={(value, ids) => { setReplyBody(value); setReplyMentions(ids); }} onEnter={() => void sendReply(thread.id)} workspaceId={workspaceId} placeholder={t.replyPlaceholder} /><button type="button" disabled={busy || !replyBody.trim()} onClick={() => void sendReply(thread.id)} className="mt-2 rounded bg-action px-2 py-1 text-xs text-action-foreground disabled:opacity-50">{t.reply}</button></div> : null}
      </div>
    </article>)}</div>
    {canComment ? <div><CommentComposer value={body} onValueChange={(value, ids) => { setBody(value); setMentions(ids); }} onEnter={() => void submit()} workspaceId={workspaceId} placeholder={anchor ? t.commentPlaceholder : t.selectToComment} /><p className="mt-1 text-xs text-muted-foreground">{t.brianCommentHint}</p><button type="button" onClick={() => void submit()} disabled={busy || !body.trim() || !anchor} className="mt-2 h-8 rounded-md bg-action px-3 text-xs font-medium text-action-foreground disabled:opacity-50">{t.comment}</button></div> : null}
  </section>;
}

function ReactionButton({ label, active, onClick, children }: { label: string; active: boolean; onClick(): void; children: React.ReactNode }) {
  return <button type="button" aria-label={label} aria-pressed={active} onClick={onClick} className="rounded border px-1.5 py-0.5 text-xs aria-pressed:bg-muted">{children}</button>;
}
