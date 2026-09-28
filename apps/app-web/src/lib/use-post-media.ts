"use client";


import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Upload durable images for a post (feed-revamp-depth D33).
 *
 * Rides the EXISTING `/api/doc-files/:workspaceId/upload` rather than a new
 * route: it already writes durable `workspace_files` rows, uuid-prefixes
 * filenames so collisions are impossible, is workspace-membership gated, caps
 * at 20 MB and counts toward the workspace quota. Displays use the shared
 * protected media hook.
 *
 * `/api/files/upload` is deliberately NOT used: it writes `file_cache` with a
 * 7-day TTL, and a post's image has to outlive the post.
 *
 * [COMP:app-web/feed-post-media]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";
import {
  ACCEPTED_MEDIA_MIME,
  postMediaUploadBatches,
  type PostMedia,
} from "@/lib/feed-media";

type UploadedFile = {
  id?: string;
  mimeType?: string;
  name?: string;
  error?: string;
};

export type MediaUploadResult = {
  media: PostMedia[];
  /** Per-file failures, already human-readable. Never silently dropped. */
  errors: string[];
};

const apiUrl = (path: string) =>
  `${publicRuntimeConfig().apiUrl ?? ""}${path}`;

export function usePostMedia(workspaceId: string) {
  const [uploading, setUploading] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const upload = useCallback(
    async (files: File[]): Promise<MediaUploadResult> => {
      const usable = files.filter((f) =>
        (ACCEPTED_MEDIA_MIME as readonly string[]).includes(f.type),
      );
      const rejected = files
        .filter((f) => !usable.includes(f))
        .map((f) => f.name);
      if (usable.length === 0) {
        return { media: [], errors: rejected };
      }

      setUploading(true);
      try {
        const media: PostMedia[] = [];
        const errors = [...rejected];

        // The durable upload route is shared with Doc and accepts ten files
        // per request. Keep that route bounded while supporting platform caps
        // above ten (LinkedIn allows twenty) through sequential batches.
        for (const batch of postMediaUploadBatches(usable)) {
          try {
            const form = new FormData();
            for (const file of batch) form.append("files", file);
            const res = await authFetch(
              apiUrl(`/api/doc-files/${workspaceId}/upload`),
              { method: "POST", body: form },
            );
            if (!res.ok) {
              errors.push(...batch.map((f) => f.name));
              continue;
            }
            const body = (await res.json()) as { files?: UploadedFile[] };
            for (const entry of body.files ?? []) {
              // A partial failure is surfaced, never filtered away: an
              // operator who dropped three images and got two must be told
              // which one is missing, not left to count thumbnails.
              if (!entry.id || entry.error) {
                errors.push(entry.name ?? entry.error ?? "upload failed");
                continue;
              }
              media.push({
                fileId: entry.id,
                mimeType: entry.mimeType ?? "image/png",
              });
            }
          } catch {
            errors.push(...batch.map((f) => f.name));
          }
        }
        return { media, errors };
      } finally {
        if (alive.current) setUploading(false);
      }
    },
    [workspaceId],
  );

  return { upload, uploading };
}
