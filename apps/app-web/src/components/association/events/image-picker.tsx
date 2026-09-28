"use client";
/** One website image: drop or upload a file in place, or pick one already in the library; alt text per language. [COMP:app-web/association] */
import { useRef, useState, type DragEvent } from "react";
import { ImagePlus, Trash2 } from "lucide-react";
import { uploadWebsiteMedia, WEBSITE_MEDIA_ACCEPT, WEBSITE_MEDIA_MAX_BYTES, type MembershipLocale, type WebsiteImage, type WebsiteMedia } from "@/lib/api/association";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AssociationField } from "../operator-controls";
import { MediaThumb } from "../site-content/document-editor";

export function ImagePicker({ workspaceId, label, value, onChange, media, onUploaded, locale, compact = false }: {
  workspaceId: string; label: string; value: WebsiteImage | undefined; onChange: (next: WebsiteImage | undefined) => void;
  media: WebsiteMedia[]; onUploaded: () => void; locale: MembershipLocale; compact?: boolean;
}) {
  const e = useT().associationPage.eventPage;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [over, setOver] = useState(false);
  const images = media.filter(item => item.mime.startsWith("image/"));
  async function upload(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError(e.notImage); return; }
    if (file.size > WEBSITE_MEDIA_MAX_BYTES) { setError(e.tooLarge); return; }
    setBusy(true); setError(null);
    try {
      const [result] = await uploadWebsiteMedia(workspaceId, [file]);
      if (!result?.media) { setError(e.uploadFailed); return; }
      onChange({ mediaId: result.media.id, alt: value?.alt ?? { en: file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ") } });
      onUploaded();
    } catch { setError(e.uploadFailed); } finally { setBusy(false); }
  }
  const drop = (event: DragEvent) => { event.preventDefault(); setOver(false); void upload(event.dataTransfer.files[0]); };
  const alt = value?.alt?.[locale] ?? "";
  return <div className="space-y-2" data-image-picker>
    <p className="text-sm font-medium">{label}</p>
    <div onDragOver={event => { event.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
      className={cn("flex flex-wrap items-center gap-3 rounded-xl border border-dashed p-3 transition-colors", over ? "border-primary bg-primary/5" : "border-border")}>
      {value?.mediaId ? <MediaThumb workspaceId={workspaceId} id={value.mediaId} /> : value?.src ? <span className="flex h-16 w-24 items-center justify-center rounded-md bg-muted text-[11px] text-muted-foreground" title={value.src}>{e.siteFile}</span>
        : <span className="flex h-16 w-24 items-center justify-center rounded-md bg-muted text-muted-foreground"><ImagePlus aria-hidden className="size-5" /></span>}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <input ref={input} type="file" accept={WEBSITE_MEDIA_ACCEPT} className="sr-only" tabIndex={-1} onChange={event => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
        <Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-8" disabled={busy} onClick={() => input.current?.click()}>{busy ? e.uploading : value ? e.replace : e.upload}</Button>
        {images.length ? <Select items={images.map(item => ({ value: item.id, label: item.name }))} value={value?.mediaId ?? ""} onValueChange={id => { if (id) onChange({ mediaId: id, alt: value?.alt ?? { en: "" } }); }}>
          <SelectTrigger className="min-h-11 w-44 md:min-h-8"><SelectValue placeholder={e.fromLibrary} /></SelectTrigger>
          <SelectContent>{images.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
        </Select> : null}
        {value ? <Button type="button" size="sm" variant="ghost" className="min-h-11 text-destructive md:min-h-8" onClick={() => onChange(undefined)}><Trash2 aria-hidden className="size-4" />{e.removeImage}</Button> : null}
        {!value && !compact ? <span className="text-xs text-muted-foreground">{e.dropHint}</span> : null}
      </div>
    </div>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {value ? <AssociationField label={e.altText} value={alt} placeholder={locale !== "en" ? value.alt.en : undefined}
      onChange={text => onChange({ ...value, alt: locale === "en" ? { ...value.alt, en: text } : { ...value.alt, [locale]: text || undefined } })} /> : null}
  </div>;
}
