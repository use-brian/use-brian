"use client";
/** Empty-by-default tags and user-approved folder rules. [COMP:app-web/meeting-tags] */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT, format } from "@/lib/i18n/client";
import { meetingTags, type MeetingTagCommand } from "@/lib/api/meeting-tags";
import { useCachedResource } from "@/lib/surface-cache";
import { meetingTagsCacheKey } from "@/lib/surface-prefetch";
import { docPagePath } from "@/lib/doc-page-url";

export function MeetingTagsPanel({ workspaceId, pageId }: { workspaceId: string; pageId: string }) {
  const t = useT().meetingTags;
  const { data, error, refresh } = useCachedResource(meetingTagsCacheKey(workspaceId, pageId), () => meetingTags(workspaceId, pageId));
  const [tags, setTags] = useState<string | null>(null);
  const [tag, setTag] = useState("");
  const [phrases, setPhrases] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setTags(null); setTag(""); setPhrases(""); setFailed(false); }, [pageId]);
  useEffect(() => {
    if (data === null) return;
    const update = () => { if (document.visibilityState !== "hidden") void refresh(); };
    const timer = window.setInterval(update, 15_000);
    window.addEventListener("focus", update);
    window.addEventListener("meeting-tags:changed", update);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", update); window.removeEventListener("meeting-tags:changed", update); };
  }, [refresh, data === null]);
  const run = async (command: MeetingTagCommand) => {
    setBusy(true); setFailed(false);
    try {
      await meetingTags(workspaceId, pageId, command);
      setTags(null); setTag(""); setPhrases("");
      await refresh();
      window.dispatchEvent(new Event("meeting-tags:changed"));
    } catch { setFailed(true); }
    finally { setBusy(false); }
  };
  if (data === null) return null;
  if (!data && !error) return <div className="mb-4 h-6 w-40 animate-pulse rounded bg-muted" aria-hidden />;
  const split = (value: string) => value.split(/[,，]/).map((part) => part.trim()).filter(Boolean);
  return <details className="mb-6 rounded-lg border p-3 text-sm">
    <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 md:min-h-8">
      <span>{t.title}</span>
      {data?.tags.map((item) => <span key={item.name} className="rounded-full bg-muted px-2 py-1">{item.name}</span>)}
    </summary>
    {(failed || !!error) && <p role="alert" className="py-2 text-destructive">{t.failed} <Button variant="ghost" onClick={() => void refresh()}>{t.retry}</Button></p>}
    {data && <div className="space-y-4 pt-3">
      <p className="text-muted-foreground">{t.help}</p>
      {!data.isFolder && <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void run({ kind: "set-tags", tags: split(tags ?? data.tags.map((item) => item.name).join(", ")) }); }}>
        <label className="min-w-0 flex-1 space-y-1"><span>{t.tags}</span><input className="w-full rounded border bg-background p-2 text-base" value={tags ?? data.tags.map((item) => item.name).join(", ")} onChange={(event) => setTags(event.target.value)} placeholder={t.commaSeparated} disabled={busy} /></label>
        <Button type="submit" disabled={busy}>{t.save}</Button>
      </form>}
      <h3 className="font-medium">{t.rules}</h3>
      {data.rules.length === 0 && <p className="text-muted-foreground">{t.noRules}</p>}
      {data.rules.map((rule) => <div key={rule.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2">
        <div><strong>{rule.tag}</strong><p className="text-muted-foreground">{format(t.match, { phrases: rule.phrases.join(", ") })}</p></div>
        <Button variant="ghost" disabled={busy} onClick={() => void run({ kind: "delete-rule", id: rule.id })}>{t.remove}</Button>
      </div>)}
      <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void run({ kind: "create-rule", tag: tag.trim(), phrases: split(phrases) }); }}>
        <label className="block space-y-1"><span>{t.ruleTag}</span><input className="w-full rounded border bg-background p-2 text-base" maxLength={64} value={tag} onChange={(event) => setTag(event.target.value)} disabled={busy} /></label>
        <label className="block space-y-1"><span>{t.rulePhrases}</span><input className="w-full rounded border bg-background p-2 text-base" value={phrases} onChange={(event) => setPhrases(event.target.value)} placeholder={t.commaSeparated} disabled={busy} /></label>
        <Button type="submit" disabled={busy || !tag.trim() || !split(phrases).length}>{t.addRule}</Button>
      </form>
      <h3 className="font-medium">{t.suggestions}</h3>
      <p className="text-muted-foreground">{t.learning}</p>
      {data.suggestions.map((rule) => <div key={rule.id} className="space-y-2 rounded border p-3">
        <strong>{rule.tag}</strong><p>{format(t.match, { phrases: rule.phrases.join(", ") })}</p>
        <div className="flex flex-wrap gap-2">{rule.pageIds.map((id, index) => <a key={id} className="inline-flex min-h-11 items-center underline" href={docPagePath(workspaceId, id)}>{format(t.example, { number: String(index + 1) })}</a>)}</div>
        <div className="flex gap-2"><Button disabled={busy} onClick={() => void run({ kind: "accept-rule", id: rule.id })}>{t.accept}</Button><Button variant="ghost" disabled={busy} onClick={() => void run({ kind: "dismiss-rule", id: rule.id })}>{t.dismiss}</Button></div>
      </div>)}
    </div>}
  </details>;
}
