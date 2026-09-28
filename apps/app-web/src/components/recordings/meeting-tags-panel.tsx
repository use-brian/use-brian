"use client";
/** Note tags and folder-owned rule settings. [COMP:app-web/meeting-tags] */
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { Tags, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useT, format } from "@/lib/i18n/client";
import { meetingTags, type MeetingTagCommand } from "@/lib/api/meeting-tags";
import { useCachedResource } from "@/lib/surface-cache";
import { meetingTagsCacheKey } from "@/lib/surface-prefetch";
import { docPagePath } from "@/lib/doc-page-url";

type Scope = { workspaceId: string; pageId: string };
const split = (value: string) => value.split(/[,，]/).map((part) => part.trim()).filter(Boolean);

function useMeetingTags({ workspaceId, pageId }: Scope) {
  const resource = useCachedResource(meetingTagsCacheKey(workspaceId, pageId), () => meetingTags(workspaceId, pageId));
  const { data, refresh } = resource;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [pageId]);
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
      await refresh();
      window.dispatchEvent(new Event("meeting-tags:changed"));
      return true;
    } catch { setFailed(true); return false; }
    finally { setBusy(false); }
  };
  return { ...resource, busy, failed, run };
}

/** Mounted lazily inside either folder overflow menu. */
export function MeetingTagRulesMenuItem(props: Scope & { onOpen: () => void }) {
  const t = useT().meetingTags;
  const { data } = useMeetingTags(props);
  return data?.isFolder ? <DropdownMenuItem onClick={props.onOpen}>{t.settings}</DropdownMenuItem> : null;
}

export function MeetingTagRulesDialog(props: Scope & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT().meetingTags;
  const pathname = usePathname();
  // A settings drawer never follows the user onto a different page.
  const location = `${pathname}:${props.pageId}`;
  const previousLocation = useRef(location);
  useEffect(() => {
    if (previousLocation.current !== location) { previousLocation.current = location; props.onOpenChange(false); }
  }, [location, props.onOpenChange]);
  return <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/20" />
      <Dialog.Popup className="fixed inset-y-0 right-0 z-50 flex h-dvh w-full max-w-lg flex-col border-l bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <Dialog.Title className="text-lg font-semibold">{t.settings}</Dialog.Title>
          <Dialog.Close render={<Button variant="ghost" size="icon" className="min-h-11 min-w-11" aria-label={t.close}><X className="size-4" /></Button>} />
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <Dialog.Description className="mb-5 text-sm text-muted-foreground">{t.help}</Dialog.Description>
          {props.open && <MeetingTagRulesContent key={props.pageId} workspaceId={props.workspaceId} pageId={props.pageId} />}
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

export function MeetingTagsPanel(props: Scope) {
  const t = useT().meetingTags;
  const { data, error, refresh, busy, failed, run } = useMeetingTags(props);
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState<string | null>(null);
  useEffect(() => { setOpen(false); setTags(null); }, [props.pageId]);
  if (data === null) return null;
  if (!data && !error) return <div className="mb-4 h-6 w-24 animate-pulse rounded bg-muted" aria-hidden />;
  const feedback = (failed || !!error) && <p role="alert" className="text-sm text-destructive">{t.failed} <Button className="min-h-11" variant="ghost" onClick={() => void refresh()}>{t.retry}</Button></p>;
  if (data?.isFolder) return <>
    {data.suggestions.length > 0 && <Button variant="ghost" className="mb-4 min-h-11 text-muted-foreground" onClick={() => setOpen(true)}>{format(t.suggestionCount, { count: String(data.suggestions.length) })}</Button>}
    <MeetingTagRulesDialog {...props} open={open} onOpenChange={setOpen} />
  </>;
  return <div className="mb-4">
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setTags(null); }}>
      <PopoverTrigger render={<button type="button" aria-label={data?.tags.length ? t.editTags : t.addTags} className="flex min-h-11 max-w-full flex-wrap items-center gap-2 rounded px-1 text-sm text-muted-foreground hover:bg-muted">
        <Tags className="size-3.5" aria-hidden />
        {data?.tags.length ? data.tags.map((item) => <span key={item.name} className="max-w-full break-words rounded-full bg-muted px-2 py-1 text-foreground">{item.name}</span>) : t.addTags}
      </button>} />
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-1rem)] p-4">
        {feedback}
        {data && <form className="space-y-3" onSubmit={async (event) => { event.preventDefault(); if (await run({ kind: "set-tags", tags: split(tags ?? data.tags.map((item) => item.name).join(", ")) })) { setOpen(false); setTags(null); } }}>
          <label className="block space-y-1"><span>{t.tags}</span><input className="w-full rounded border bg-background p-2 text-base" value={tags ?? data.tags.map((item) => item.name).join(", ")} onChange={(event) => setTags(event.target.value)} placeholder={t.commaSeparated} disabled={busy} /></label>
          <Button className="min-h-11" type="submit" disabled={busy}>{t.save}</Button>
        </form>}
      </PopoverContent>
    </Popover>
  </div>;
}

function MeetingTagRulesContent(props: Scope) {
  const t = useT().meetingTags;
  const { data, error, refresh, busy, failed, run } = useMeetingTags(props);
  const [tag, setTag] = useState("");
  const [phrases, setPhrases] = useState("");
  const workspaceId = props.workspaceId;
  if (data === undefined && !error) return <div className="h-24 animate-pulse rounded bg-muted" aria-hidden />;
  return <div className="space-y-4 text-sm">
    {(failed || !!error || data === null) && <p role="alert" className="text-destructive">{t.failed} <Button className="min-h-11" variant="ghost" onClick={() => void refresh()}>{t.retry}</Button></p>}
    {data?.isFolder && <>
      <h3 className="font-medium">{t.rules}</h3>
      {data.rules.length === 0 && <p className="text-muted-foreground">{t.noRules}</p>}
      {data.rules.map((rule) => <div key={rule.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2">
        <div><strong>{rule.tag}</strong><p className="text-muted-foreground">{format(t.match, { phrases: rule.phrases.join(", ") })}</p></div>
        <Button className="min-h-11" variant="ghost" disabled={busy} onClick={() => void run({ kind: "delete-rule", id: rule.id })}>{t.remove}</Button>
      </div>)}
      <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void run({ kind: "create-rule", tag: tag.trim(), phrases: split(phrases) }).then((saved) => { if (saved) { setTag(""); setPhrases(""); } }); }}>
        <label className="block space-y-1"><span>{t.ruleTag}</span><input className="w-full rounded border bg-background p-2 text-base" maxLength={64} value={tag} onChange={(event) => setTag(event.target.value)} disabled={busy} /></label>
        <label className="block space-y-1"><span>{t.rulePhrases}</span><input className="w-full rounded border bg-background p-2 text-base" value={phrases} onChange={(event) => setPhrases(event.target.value)} placeholder={t.commaSeparated} disabled={busy} /></label>
        <Button className="min-h-11" type="submit" disabled={busy || !tag.trim() || !split(phrases).length}>{t.addRule}</Button>
      </form>
      <h3 className="font-medium">{t.suggestions}</h3>
      <p className="text-muted-foreground">{t.learning}</p>
      {data.suggestions.map((rule) => <div key={rule.id} className="space-y-2 rounded border p-3">
        <strong>{rule.tag}</strong><p>{format(t.match, { phrases: rule.phrases.join(", ") })}</p>
        <div className="flex flex-wrap gap-2">{rule.pageIds.map((id, index) => <a key={id} className="inline-flex min-h-11 items-center underline" href={docPagePath(workspaceId, id)}>{format(t.example, { number: String(index + 1) })}</a>)}</div>
        <div className="flex gap-2"><Button className="min-h-11" disabled={busy} onClick={() => void run({ kind: "accept-rule", id: rule.id })}>{t.accept}</Button><Button className="min-h-11" variant="ghost" disabled={busy} onClick={() => void run({ kind: "dismiss-rule", id: rule.id })}>{t.dismiss}</Button></div>
      </div>)}
    </>}
  </div>;
}
