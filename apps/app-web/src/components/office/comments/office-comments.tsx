"use client";

/** Semantic/spatial Office comments with explicit @Brian invocation. [COMP:app-web/office-comments] */
import { useEffect, useState } from "react";
import { APP_LEVEL_ASSISTANT_ID } from "@use-brian/shared";
import { createOfficeComment, listOfficeComments, resolveOfficeComment, type OfficeCommentThread } from "@/lib/office/api";
import { useT } from "@/lib/i18n/client";
import { appendOfflineCommand, listOfflineJournal, removeOfflineJournalEntry } from "@/lib/office/offline";

export function OfficeComments({ artifactId, version, targetIds, anchorKind = "object", canComment, offline = false, initialThreads }: { artifactId: string; version: number; targetIds: string[]; anchorKind?: OfficeCommentThread["anchor"]["kind"]; canComment: boolean; offline?: boolean; initialThreads?: OfficeCommentThread[] }) {
  const t = useT().office;
  const [threads, setThreads] = useState<OfficeCommentThread[]>(initialThreads ?? []);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const reload = () => listOfficeComments(artifactId).then(setThreads).catch(() => setThreads([]));
  useEffect(() => { if (offline) setThreads(initialThreads ?? []); else void reload(); }, [artifactId, offline, initialThreads]);
  useEffect(() => {
    if (offline) return;
    void listOfflineJournal(artifactId).then(async (entries) => {
      for (const entry of entries) {
        if (entry.kind !== "comment") continue;
        await createOfficeComment({ artifactId, anchor: entry.anchor as OfficeCommentThread["anchor"], body: entry.body, invokeBrian: entry.invokeBrian });
        await removeOfflineJournalEntry(entry);
      }
      if (entries.some((entry) => entry.kind === "comment")) await reload();
    }).catch(() => undefined);
  }, [artifactId, offline]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!body.trim() || targetIds.length === 0) return;
    setBusy(true);
    const invoke = /(^|\s)@Brian\b/i.test(body);
    try {
      const invokeBrian = invoke ? { assistantId: APP_LEVEL_ASSISTANT_ID, expectedVersion: version, idempotencyKey: crypto.randomUUID() } : undefined;
      if (offline) {
        const createdAt = new Date().toISOString();
        const seq = Date.now() * 1_000 + Math.floor(Math.random() * 1_000);
        await appendOfflineCommand({ artifactId, seq, kind: "comment", anchor: { kind: anchorKind, targetIds }, body: body.trim(), invokeBrian, createdAt });
        setThreads((current) => [...current, { id: `offline:${seq}`, artifactVersionId: String(version), anchorKind, anchor: { kind: anchorKind, targetIds }, status: "open", messages: [{ id: `offline-message:${seq}`, authorType: "user", body: body.trim(), createdAt }] }]);
      } else await createOfficeComment({ artifactId, anchor: { kind: anchorKind, targetIds }, body: body.trim(), invokeBrian });
      setBody("");
      if (!offline) await reload();
    } finally { setBusy(false); }
  }

  return <section aria-label={t.comments} className="space-y-4">
    <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">{t.comments}</h2><span className="text-xs text-muted-foreground">{threads.filter((thread) => thread.status === "open").length}</span></div>
    <div className="max-h-80 space-y-3 overflow-y-auto">{threads.map((thread) => <article key={thread.id} className="rounded-lg border p-3"><div className="space-y-2">{thread.messages.map((message) => <p key={message.id} className="text-sm">{message.body}</p>)}</div><div className="mt-2 flex items-center justify-between text-xs text-muted-foreground"><span>{thread.status === "detached" ? t.detachedComment : thread.status === "resolved" ? t.resolved : t.open}</span>{thread.status !== "detached" && canComment ? <button type="button" onClick={() => void resolveOfficeComment(thread.id, thread.status !== "resolved").then(reload)} className="hover:underline">{thread.status === "resolved" ? t.reopen : t.resolve}</button> : null}</div></article>)}</div>
    {canComment ? <form onSubmit={submit}><textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder={targetIds.length ? t.commentPlaceholder : t.selectToComment} disabled={targetIds.length === 0} className="min-h-20 w-full rounded-md border bg-background p-2 text-sm disabled:opacity-50" /><p className="mt-1 text-xs text-muted-foreground">{t.brianCommentHint}</p><button type="submit" disabled={busy || !body.trim() || targetIds.length === 0} className="mt-2 h-8 rounded-md bg-action px-3 text-xs font-medium text-action-foreground disabled:opacity-50">{t.comment}</button></form> : null}
  </section>;
}
