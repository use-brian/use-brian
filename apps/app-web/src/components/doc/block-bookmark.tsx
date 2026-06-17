"use client";

// [COMP:app-web/block-bookmark]
/**
 * Phase 2 media block — `kind: 'bookmark'`.
 *
 * Three visual states keyed on `url` + `meta`:
 *
 *   1. `url === ''`     → URL input. On blur / Enter we fire `onChange`
 *                          with the trimmed URL and trigger an OG fetch.
 *   2. `url` set, no `meta`  → loading shimmer + background fetch from
 *                          `POST /api/doc/og-preview` (P2C). On
 *                          response we fire `onChange({ meta })`.
 *   3. `url` + `meta` set    → bookmark card (image + title +
 *                          description + site name). The card is a
 *                          link that opens `url` in a new tab.
 *
 * Fallback: if `/api/doc/og-preview` is unreachable (e.g. P2C still
 * landing), we render a degraded card with just the URL + an external
 * link. The `meta` field stays unset so the next mount retries.
 */

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type BookmarkMeta = {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
};

export type BookmarkBlock = {
  kind: "bookmark";
  id: string;
  url: string;
  meta?: BookmarkMeta;
};

type Props = {
  block: BookmarkBlock;
  blockId: string;
  readOnly?: boolean;
  onChange?: (patch: Partial<BookmarkBlock>) => void;
  onAction?: (actionId: string, params?: Record<string, unknown>) => void;
};

function ExternalLinkIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0 text-muted-foreground"
    >
      <path d="M6 3H3v10h10v-3M9 3h4v4M13 3L7 9" />
    </svg>
  );
}

function hostnameFor(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function BlockBookmark({ block, readOnly, onChange }: Props) {
  const t = useT().docPage;
  const [draftUrl, setDraftUrl] = useState<string>(block.url);
  const [loading, setLoading] = useState<boolean>(false);
  const [fetchFailed, setFetchFailed] = useState<boolean>(false);
  // Track which URL we've already requested so a re-render doesn't
  // refetch on every paint.
  const fetchedFor = useRef<string | null>(null);

  // Auto-fetch OG metadata when we have a URL but no meta yet.
  useEffect(() => {
    if (!block.url || block.meta) {
      return;
    }
    if (fetchedFor.current === block.url) {
      return;
    }
    fetchedFor.current = block.url;
    let cancelled = false;
    setLoading(true);
    setFetchFailed(false);
    void (async () => {
      try {
        const res = await authFetch(`${API_URL}/api/doc/og-preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: block.url }),
        });
        if (cancelled) return;
        if (!res.ok) {
          // P2C endpoint not wired yet, or upstream fetch errored.
          // Degrade to the bare-URL fallback card.
          setFetchFailed(true);
          return;
        }
        const meta = (await res.json()) as BookmarkMeta;
        if (cancelled) return;
        onChange?.({ meta });
      } catch {
        if (!cancelled) setFetchFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [block.url, block.meta, onChange]);

  function commitUrl(): void {
    const trimmed = draftUrl.trim();
    if (!trimmed || trimmed === block.url) return;
    // Reset the dedupe so the effect kicks off a fresh fetch.
    fetchedFor.current = null;
    onChange?.({ url: trimmed, meta: undefined });
  }

  // ── Empty state — URL input ─────────────────────────────────────────
  if (!block.url) {
    return (
      <div className="w-full">
        <input
          type="url"
          inputMode="url"
          placeholder={t.mediaBlock.bookmarkPlaceholder}
          value={draftUrl}
          disabled={readOnly}
          onChange={(e) => setDraftUrl(e.target.value)}
          onBlur={commitUrl}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitUrl();
            }
          }}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-foreground/20 focus:outline-none"
        />
      </div>
    );
  }

  // ── Loading shimmer ─────────────────────────────────────────────────
  if (loading && !block.meta && !fetchFailed) {
    return (
      <div
        aria-busy="true"
        aria-label={t.mediaBlock.bookmarkLoading}
        className="flex w-full items-center gap-3 rounded-md border border-border bg-muted/20 px-3 py-3"
      >
        <div className="h-10 w-10 shrink-0 animate-pulse rounded bg-muted" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-2.5 w-1/2 animate-pulse rounded bg-muted/70" />
        </div>
      </div>
    );
  }

  // ── Filled card (or degraded fallback) ──────────────────────────────
  const meta = block.meta ?? {};
  const host = hostnameFor(block.url);
  const title = meta.title ?? host;
  const description = meta.description;
  const siteLabel = meta.siteName ?? host;

  return (
    <a
      href={block.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex w-full items-stretch gap-0 overflow-hidden rounded-md border border-border bg-background text-left no-underline transition-colors hover:border-foreground/30 hover:bg-muted/20"
    >
      <div className="min-w-0 flex-1 p-3">
        <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          {meta.favicon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={meta.favicon}
              alt=""
              width={14}
              height={14}
              loading="lazy"
              className="h-3.5 w-3.5 rounded-sm"
            />
          ) : (
            <ExternalLinkIcon />
          )}
          <span className="truncate">{siteLabel}</span>
        </div>
        <div className="line-clamp-2 text-sm font-medium text-foreground">
          {title}
        </div>
        {description && (
          <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {description}
          </div>
        )}
        {fetchFailed && !meta.title && (
          <div className="mt-1 text-[11px] text-muted-foreground/70">
            {t.mediaBlock.bookmarkFallback}
          </div>
        )}
      </div>
      {meta.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={meta.image}
          alt=""
          loading="lazy"
          className="h-auto w-32 shrink-0 self-stretch object-cover"
        />
      )}
    </a>
  );
}
