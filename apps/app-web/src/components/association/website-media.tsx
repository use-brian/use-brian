"use client";
/** Website media library: upload, preview and remove the images and PDFs the public sites render. [COMP:app-web/association] */
import { useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { deleteWebsiteMedia, listWebsiteMedia, uploadWebsiteMedia, websiteMediaPreviewUrl, WEBSITE_MEDIA_ACCEPT, WEBSITE_MEDIA_MAX_BYTES, type WebsiteMedia } from "@/lib/api/association";
import { useT } from "@/lib/i18n/client";
import { useCachedResource } from "@/lib/surface-cache";
import { associationPageCacheKey } from "@/lib/surface-prefetch";
import { Button } from "@/components/ui/button";
import { AssociationListState, useAssociationAction } from "./operator-controls";
import { useAssociationModule } from "./module-controls";
import { InlineNotice, PageHeader } from "./ui";

const size = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

function Thumbnail({ workspaceId, media }: { workspaceId: string; media: WebsiteMedia }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!media.mime.startsWith("image/")) return;
    let live = true;
    websiteMediaPreviewUrl(workspaceId, media.id).then(value => { if (live) setUrl(value); }).catch(() => undefined);
    return () => { live = false; };
  }, [workspaceId, media.id, media.mime]);
  if (!media.mime.startsWith("image/")) return <div className="flex aspect-[4/3] items-center justify-center rounded-lg bg-muted"><FileText aria-hidden className="size-8 text-muted-foreground"/></div>;
  // eslint-disable-next-line @next/next/no-img-element -- signed storage URL, not an optimisable asset
  return url ? <img src={url} alt="" className="aspect-[4/3] w-full rounded-lg bg-muted object-cover"/> : <div className="aspect-[4/3] animate-pulse rounded-lg bg-muted"/>;
}

export function WebsiteMediaPanel({ workspaceId }: { workspaceId: string }) {
  const t = useT().associationPage, c = t.media;
  const module = useAssociationModule(workspaceId), manage = !!module.data?.canManage;
  const read = useCachedResource(associationPageCacheKey(workspaceId, "website-media"), () => listWebsiteMedia(workspaceId));
  const action = useAssociationAction(workspaceId);
  const input = useRef<HTMLInputElement>(null);
  const [rejected, setRejected] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);

  async function upload(list: FileList | null) {
    const files = [...(list ?? [])];
    if (!files.length) return;
    const tooLarge = files.filter(file => file.size > WEBSITE_MEDIA_MAX_BYTES).map(file => file.name);
    const ok = files.filter(file => file.size <= WEBSITE_MEDIA_MAX_BYTES);
    let failed: string[] = [];
    if (ok.length) await action.run(c.upload, async () => {
      const results = await uploadWebsiteMedia(workspaceId, ok);
      failed = results.filter(row => row.error).map(row => row.name);
    }, false);
    setRejected([...tooLarge, ...failed]);
    if (input.current) input.current.value = "";
    await read.refresh();
  }
  async function remove(media: WebsiteMedia) {
    if (await action.run(c.remove, () => deleteWebsiteMedia(workspaceId, media.id), { description: c.removeHelp, destructive: true })) await read.refresh();
  }
  async function copy(id: string) {
    try { await navigator.clipboard.writeText(id); setCopied(id); } catch { setCopied(null); }
  }

  return <section className="space-y-4">
    <PageHeader level={2} title={c.title} description={c.help}/>
    {manage && <div className="flex flex-wrap items-center gap-3">
      <input ref={input} id="website-media-upload" type="file" multiple accept={WEBSITE_MEDIA_ACCEPT} className="sr-only" onChange={event => void upload(event.target.files)}/>
      <Button className="max-sm:min-h-11" disabled={action.pending} onClick={() => input.current?.click()}>{c.upload}</Button>
      <p className="text-xs text-muted-foreground">{c.limits}</p>
    </div>}
    {action.feedback}
    {rejected.length > 0 && <InlineNotice tone="danger">{c.rejected}: {rejected.join(", ")}</InlineNotice>}
    <AssociationListState {...read}>
      {read.data?.length === 0 && <InlineNotice tone="neutral">{c.empty}</InlineNotice>}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{(read.data ?? []).map(media => <li key={media.id} className="min-w-0 space-y-2 rounded-xl border p-3">
        <Thumbnail workspaceId={workspaceId} media={media}/>
        <p className="truncate text-sm font-medium" title={media.name}>{media.name}</p>
        <p className="text-xs text-muted-foreground">{size(media.sizeBytes)}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="min-h-11 md:min-h-8" onClick={() => void copy(media.id)}>{copied === media.id ? c.copied : c.copyId}</Button>
          {manage && <Button size="sm" variant="ghost" className="min-h-11 text-destructive md:min-h-8" disabled={action.pending} onClick={() => void remove(media)}>{c.remove}</Button>}
        </div>
      </li>)}</ul>
    </AssociationListState>
  </section>;
}
