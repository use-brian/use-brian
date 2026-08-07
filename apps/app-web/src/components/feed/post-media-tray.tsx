"use client";

/**
 * The composer's media strip (feed-revamp-depth D32-D34).
 *
 * It also absorbs `image_brief`, which until now was an inert read-only card
 * floating below the editor that no consumer read. As this tray's empty-state
 * hint it becomes the one cheap intervention point BEFORE media exists -
 * exactly the gap that produces the "AI attached a photo of a guy welding with
 * a wrench" complaint in comparable products, where media is policy-selected
 * and the operator has nowhere to correct it early.
 *
 * Delivery is named honestly per platform rather than implied: on a target
 * that cannot publish media through its API, the tray says the image is for
 * the operator to attach by hand. Silently accepting an image the approve path
 * will drop is the worst failure available here.
 *
 * [COMP:app-web/feed-post-media-tray]
 */

import { useEffect, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { usePostMedia } from "@/lib/use-post-media";
import {
  ACCEPTED_MEDIA_MIME,
  canPublishMedia,
  mediaCapFor,
  type PostMedia,
} from "@/lib/feed-media";
import type { FeedPlatform } from "@/lib/feed-nav";

function Thumb({
  media,
  resolve,
  onRemove,
  readOnly,
}: {
  media: PostMedia;
  resolve: (fileId: string) => Promise<string | null>;
  onRemove: () => void;
  readOnly: boolean;
}) {
  const tm = useT().feedPage.postEditor;
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void resolve(media.fileId).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [media.fileId, resolve]);

  return (
    <div className="group/thumb relative size-16 overflow-hidden rounded-lg border border-border/60 bg-muted">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={media.alt ?? ""}
          className="size-full object-cover"
        />
      ) : null}
      {!readOnly ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={tm.mediaRemove}
          className="absolute right-0.5 top-0.5 inline-flex size-5 items-center justify-center rounded-full bg-background/90 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/thumb:opacity-100"
        >
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

export function PostMediaTray({
  workspaceId,
  platform,
  media,
  imageBrief,
  readOnly,
  onChange,
}: {
  workspaceId: string;
  platform: FeedPlatform;
  media: PostMedia[];
  /** The written shot note, now this tray's empty-state hint. */
  imageBrief?: string | null;
  readOnly: boolean;
  onChange: (next: PostMedia[]) => void;
}) {
  const tm = useT().feedPage.postEditor;
  const { upload, resolve, uploading } = usePostMedia(workspaceId);
  const [errors, setErrors] = useState<string[]>([]);
  const cap = mediaCapFor(platform);
  const full = media.length >= cap;

  async function add(files: File[]) {
    if (files.length === 0) return;
    const room = cap - media.length;
    const result = await upload(files.slice(0, room));
    setErrors(result.errors);
    if (result.media.length > 0) onChange([...media, ...result.media]);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          {tm.mediaLabel}
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {media.length} / {cap}
        </span>
      </div>

      <div
        onDragOver={(e) => {
          if (readOnly || full) return;
          e.preventDefault();
        }}
        onDrop={(e) => {
          if (readOnly || full) return;
          e.preventDefault();
          void add(Array.from(e.dataTransfer.files));
        }}
        className="flex flex-wrap items-center gap-2"
      >
        {media.map((item, i) => (
          <Thumb
            key={item.fileId}
            media={item}
            resolve={resolve}
            readOnly={readOnly}
            onRemove={() => onChange(media.filter((_, k) => k !== i))}
          />
        ))}

        {!readOnly && !full ? (
          <label
            className={cn(
              "inline-flex size-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              uploading && "pointer-events-none opacity-60",
            )}
          >
            <ImagePlus className="size-4" aria-hidden />
            <span className="text-[10px]">{tm.mediaAdd}</span>
            <input
              type="file"
              multiple
              accept={ACCEPTED_MEDIA_MIME.join(",")}
              className="hidden"
              onChange={(e) => {
                void add(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
          </label>
        ) : null}
      </div>

      {media.length === 0 && imageBrief?.trim() ? (
        <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">
            {tm.imageBriefLabel}
          </span>{" "}
          {imageBrief}
        </p>
      ) : null}

      {media.length > 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {canPublishMedia(platform)
            ? tm.mediaConnectedDelivery
            : tm.mediaManualDelivery}
        </p>
      ) : null}

      {errors.length > 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {tm.mediaFailed}: {errors.join(", ")}
        </p>
      ) : null}
    </div>
  );
}
