"use client";

import { buttonVariants } from "@/components/ui/button";
import { officeInputClassName } from "@/components/office/office-chrome";

/** Semantic/spatial Office comments with range anchors and task workflows. [COMP:app-web/office-comments] */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { APP_LEVEL_ASSISTANT_ID } from "@use-brian/shared";
import { awaitOfficeJob } from "@/lib/office/job-stream";
import { createOfficeComment, listOfficeComments, reactOfficeComment, replyOfficeComment, resolveOfficeComment, updateOfficeCommentThread, type OfficeCommentThread, OfficeApiError } from "@/lib/office/api";
import { useOptionalWorkspaceContext } from "@/lib/workspace-context";
import { getUserInfo } from "@/lib/user";
import { Skeleton } from "@/components/skeleton";
import { useOfficeMetadataResource } from "@/lib/office/surface-cache";
import { officeMetadataRemaining } from "@/lib/office/metadata";
import { officePanelCachePrefix, officePanelCacheKey } from "@/lib/surface-prefetch";
import { invalidateSurfaceCache, readSurfaceCache } from "@/lib/surface-cache";
import { useT } from "@/lib/i18n/client";
import { appendOfflineCommand, listOfflineJournal, removeOfflineJournalEntry } from "@/lib/office/offline";
import { CommentComposer } from "@/components/doc/comment-composer";
import { isCurrentDirectoryPerson } from "@/lib/api/mentions";
import { useWorkspaceDirectory } from "@/lib/use-workspace-directory";
import { SearchableSelect } from "@/components/ui/searchable-select";

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
  initialQueuedThreads?: OfficeCommentThread[];
  onQueuedThreadsChange?(threads: OfficeCommentThread[]): void;
  onRevisionCompleted?(): void | Promise<void>;
  onThreadsChange?(threads: OfficeCommentThread[]): void;
};

const EMPTY_THREADS: OfficeCommentThread[] = [];

export function OfficeComments(props: OfficeCommentsProps) {
  const workspace = useOptionalWorkspaceContext();
  const viewerId = workspace?.workspaceId === props.workspaceId ? workspace.me.id : "";
  const prefix = viewerId ? officePanelCachePrefix(props.workspaceId, viewerId) : null;
  const cacheKey = officePanelCacheKey(prefix, "comments", props.artifactId);
  const read = useOfficeMetadataResource(props.offline ? null : cacheKey, viewerId, () => listOfficeComments(props.artifactId));
  const threads = props.offline ? props.initialThreads ?? EMPTY_THREADS : read.data;
  const t = useT().office;
  useLayoutEffect(() => {if (!threads) props.onThreadsChange?.(EMPTY_THREADS);}, [threads, props.onThreadsChange]);
  if (!threads) return <section aria-label={t.comments}><h2 className="text-sm font-semibold">{t.comments}</h2>{read.error ? <p role="alert" className="text-xs text-destructive">{t.loadFailed}</p> : <Skeleton className="h-24 w-full"/>}</section>;
  return <OfficeCommentsContent key={`${cacheKey}:${Boolean(props.offline)}`} {...props} viewerId={viewerId} sourceThreads={threads} cacheKey={cacheKey} refresh={read.refresh} />;
}

function OfficeCommentsContent({ artifactId, workspaceId, version, targetIds, selectionAnchor, anchorKind = "object", canComment, offline = false, initialQueuedThreads, onQueuedThreadsChange, onRevisionCompleted, onThreadsChange, viewerId, sourceThreads, cacheKey, refresh }: OfficeCommentsProps & {viewerId: string; sourceThreads: OfficeCommentThread[]; cacheKey: string | null; refresh: () => Promise<OfficeCommentThread[] | undefined>}) {
  const offlineOwner = useMemo(() => ({workspaceId, userId: viewerId}), [workspaceId, viewerId]);
  const t = useT().office;
  const [queuedThreads, setQueuedThreads] = useState<OfficeCommentThread[]>(initialQueuedThreads ?? EMPTY_THREADS);
  useLayoutEffect(() => {if (offline) onQueuedThreadsChange?.(queuedThreads);}, [offline, queuedThreads, onQueuedThreadsChange]);
  const threads = useMemo(() => offline ? [...sourceThreads, ...queuedThreads] : sourceThreads, [offline, sourceThreads, queuedThreads]);
  useLayoutEffect(() => {onThreadsChange?.(threads); return () => onThreadsChange?.(EMPTY_THREADS);}, [threads, onThreadsChange]);
  const [body, setBody] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [replying, setReplying] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [replyMentions, setReplyMentions] = useState<string[]>([]);
  useEffect(() => {if (replying && !threads.some(thread => thread.id === replying)) {setReplying(null);setReplyBody("");setReplyMentions([]);}}, [threads, replying]);
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const members = useWorkspaceDirectory(workspaceId);
  const memberItems = members.map(member => ({value: member.id, label: member.name, hint: member.email ?? undefined}));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const lifetime = useRef<symbol | null>(null);
  const pending = useRef(false);
  const canAct = useRef(canComment);
  useLayoutEffect(() => {canAct.current = canComment;}, [canComment]);
  useLayoutEffect(() => {lifetime.current = Symbol(); return () => {lifetime.current = null;};}, []);
  function owned() {
    return lifetime.current !== null && getUserInfo()?.id === viewerId && (offline || officeMetadataRemaining(readSurfaceCache<OfficeCommentThread[]>(cacheKey).data, viewerId) > 0);
  }
  async function run(action: (current: () => boolean) => Promise<void>) {
    if (!owned() || pending.current || !canComment) return;
    const owner = lifetime.current;
    const current = () => owner === lifetime.current && canAct.current && owned();
    pending.current = true;setBusy(true);setFailed(false);
    try {await action(current);}
    catch (error) {
      if (current()) {
        if (cacheKey && error instanceof OfficeApiError && [401,403,404].includes(error.status)) invalidateSurfaceCache(cacheKey);
        else setFailed(true);
      }
    } finally {if (owner === lifetime.current) {pending.current = false;setBusy(false);}}
  }
  async function reload(current: () => boolean) {
    if (!current() || offline) return;
    if (readSurfaceCache(cacheKey).revalidating) {await refresh();if (!current()) return;}
    await refresh();
  }
  function currentThread(threadId: string) {
    return readSurfaceCache<OfficeCommentThread[]>(cacheKey).data?.find(thread => thread.id === threadId);
  }
  async function mutateThread(threadId: string, action: () => Promise<void>, messageId?: string) {
    if (offline) return;
    await run(async current => {
      const thread = currentThread(threadId);
      if (!thread || (messageId && !thread.messages.some(message => message.id === messageId))) return;
      await action();
      await reload(current);
    });
  }
  useEffect(() => {
    if (offline || !canComment) return;
    let active = true;
    void listOfflineJournal(artifactId, offlineOwner).then(async entries => {
      const comments = entries.filter(entry => entry.kind === "comment");
      if (!active || !comments.length) return;
      await run(async current => {
        for (const entry of comments) {
          if (!active || !current()) return;
          await createOfficeComment({artifactId, anchor: entry.anchor as OfficeCommentThread["anchor"], body: entry.body, mentions: entry.mentions, invokeBrian: entry.invokeBrian});
          await removeOfflineJournalEntry(entry, offlineOwner);
        }
        if (active) await reload(current);
      });
    }).catch(() => undefined);
    return () => {active = false;};
  }, [artifactId, offline, offlineOwner, viewerId, canComment]);

  const anchor = selectionAnchor ?? (targetIds.length ? { kind: anchorKind, targetIds } : null);

  async function submit() {
    if (!body.trim() || !anchor) return;
    const invoke = /(^|\s)@Brian\b/i.test(body);
    await run(async current => {
      const invokeBrian = invoke ? {assistantId: APP_LEVEL_ASSISTANT_ID, expectedVersion: version, idempotencyKey: crypto.randomUUID()} : undefined;
      if (offline) {
        const createdAt = new Date().toISOString();
        const seq = Date.now() * 1_000 + Math.floor(Math.random() * 1_000);
        await appendOfflineCommand({artifactId, seq, kind: "comment", anchor, body: body.trim(), mentions, invokeBrian, createdAt}, offlineOwner);
        if (!current()) return;
        setQueuedThreads(rows => [...rows, {id: `offline:${seq}`, artifactVersionId: String(version), anchorKind: anchor.kind, anchor, status: "open", messages: [{id: `offline-message:${seq}`, authorType: "user", body: body.trim(), mentions, createdAt}]}]);
      } else {
        const created = await createOfficeComment({artifactId, anchor, body: body.trim(), mentions, invokeBrian});
        if (!current()) return;
        if (created.revision && typeof created.revision === "object") {
          const job = await awaitOfficeJob(created.revision.jobId, current);
          if (current() && job.status === "completed") await onRevisionCompleted?.();
        }
      }
      if (!current()) return;
      setBody("");setMentions([]);
      await reload(current);
    });
  }

  async function sendReply(threadId: string) {
    if (!replyBody.trim() || offline || !currentThread(threadId)) return;
    await run(async current => {
      await replyOfficeComment(threadId, replyBody.trim(), replyMentions);
      if (!current()) return;
      setReplyBody("");setReplyMentions([]);setReplying(null);
      await reload(current);
    });
  }

  async function assign(thread: OfficeCommentThread, value: string) {
    if (value !== "brian" && value !== "unassigned" && !isCurrentDirectoryPerson(workspaceId, value)) return;
    await mutateThread(thread.id, () => updateOfficeCommentThread(thread.id, {assignedUserId: value !== "brian" && value !== "unassigned" ? value : null, assignedToBrian: value === "brian", dueAt: thread.dueAt ?? null}));
  }

  const visible = threads.filter((thread) => thread.status === filter || (filter === "open" && thread.status === "detached"));
  const assignees = [{ value: "unassigned", label: t.unassigned }, { value: "brian", label: t.brian }, ...memberItems];
  return <section aria-label={t.comments} className="space-y-4">
    <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">{t.comments}</h2><div className="flex gap-1"><button type="button" aria-pressed={filter === "open"} onClick={() => setFilter("open")} className={buttonVariants({ variant: "ghost", size: "sm", className: "aria-pressed:bg-muted" })}>{t.open}</button><button type="button" aria-pressed={filter === "resolved"} onClick={() => setFilter("resolved")} className={buttonVariants({ variant: "ghost", size: "sm", className: "aria-pressed:bg-muted" })}>{t.resolved}</button></div></div>
    <div className="space-y-3">{visible.map((thread) => <article key={thread.id} className="rounded-lg border p-3" data-comment-status={thread.status}>
      <div className="space-y-2">{thread.messages.map((message) => <div key={message.id}><p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>{canComment && !offline ? <div className="mt-1 flex gap-1"><ReactionButton label={t.thumbsUp} active={Boolean(message.reactions?.thumbs_up?.length)} onClick={() => void mutateThread(thread.id, () => reactOfficeComment(message.id, "thumbs_up", !message.reactions?.thumbs_up?.length), message.id)}>👍</ReactionButton><ReactionButton label={t.heart} active={Boolean(message.reactions?.heart?.length)} onClick={() => void mutateThread(thread.id, () => reactOfficeComment(message.id, "heart", !message.reactions?.heart?.length), message.id)}>♥</ReactionButton><ReactionButton label={t.check} active={Boolean(message.reactions?.check?.length)} onClick={() => void mutateThread(thread.id, () => reactOfficeComment(message.id, "check", !message.reactions?.check?.length), message.id)}>✓</ReactionButton></div> : null}</div>)}</div>
      <div className="mt-2 space-y-2">
        {canComment && !offline && thread.status !== "detached" ? <div className="grid grid-cols-2 items-end gap-2"><SearchableSelect value={thread.assignedToBrian ? "brian" : thread.assignedUserId ?? "unassigned"} onValueChange={(value) => void assign(thread, value)} items={assignees} placeholder={t.assignComment} searchPlaceholder={t.searchMembers} emptyMessage={t.noMembers} aria-label={t.assignComment} className="h-8 text-xs" /><label className="block text-xs text-muted-foreground">{t.dueDate}<input type="date" value={thread.dueAt?.slice(0, 10) ?? ""} onChange={(event) => {const dueAt = event.target.value ? `${event.target.value}T00:00:00.000Z` : null; void mutateThread(thread.id, () => updateOfficeCommentThread(thread.id, {assignedUserId: thread.assignedUserId ?? null, assignedToBrian: thread.assignedToBrian ?? false, dueAt}));}} className={`${officeInputClassName} mt-1 h-8 w-full`} /></label></div> : null}
        <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{thread.status === "detached" ? t.detachedComment : thread.status === "resolved" ? t.resolved : t.open}</span>{thread.status !== "detached" && canComment && !offline ? <div className="flex gap-2"><button type="button" onClick={() => setReplying(replying === thread.id ? null : thread.id)} className={buttonVariants({ variant: "ghost", size: "sm" })}>{t.reply}</button><button type="button" onClick={() => void mutateThread(thread.id, () => resolveOfficeComment(thread.id, thread.status !== "resolved"))} className={buttonVariants({ variant: "ghost", size: "sm" })}>{thread.status === "resolved" ? t.reopen : t.resolve}</button></div> : null}</div>
        {replying === thread.id ? <div><CommentComposer value={replyBody} onValueChange={(value, ids) => { setReplyBody(value); setReplyMentions(ids); }} onEnter={() => void sendReply(thread.id)} workspaceId={workspaceId} placeholder={t.replyPlaceholder} /><button type="button" disabled={busy || !replyBody.trim()} onClick={() => void sendReply(thread.id)} className={buttonVariants({ variant: "default", size: "sm", className: "mt-2" })}>{t.reply}</button></div> : null}
      </div>
    </article>)}</div>
    {failed ? <p role="alert" className="text-xs text-destructive">{t.loadFailed}</p> : null}
    {canComment ? <div><CommentComposer value={body} onValueChange={(value, ids) => { setBody(value); setMentions(ids); }} onEnter={() => void submit()} workspaceId={workspaceId} placeholder={anchor ? t.commentPlaceholder : t.selectToComment} /><p className="mt-1 text-xs text-muted-foreground">{t.brianCommentHint}</p><button type="button" onClick={() => void submit()} disabled={busy || !body.trim() || !anchor} className={buttonVariants({ variant: "default", size: "sm", className: "mt-2" })}>{t.comment}</button></div> : null}
  </section>;
}

function ReactionButton({ label, active, onClick, children }: { label: string; active: boolean; onClick(): void; children: React.ReactNode }) {
  return <button type="button" aria-label={label} aria-pressed={active} onClick={onClick} className={buttonVariants({ variant: "outline", size: "sm", className: "aria-pressed:bg-muted" })}>{children}</button>;
}
