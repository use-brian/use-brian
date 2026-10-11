"use client";

/**
 * The Chat side pane's `page` and `url` tab bodies (chat-parity T9, T10).
 *
 * - `page`: the existing collaborative page editor, live and editable in
 *   place, on its own Yjs connection. The doc shell's tab strip does not
 *   apply here; the tab's "Open full page" action navigates to `/p/<id>`.
 * - `url`: a page that may be framed (`embeddable` from the link-preview
 *   probe) renders in a sandboxed iframe; any other renders a link card
 *   (title, favicon, domain) whose "Open in browser" is the only way out.
 *   On the desktop app a `url` tab is a native browser tab instead (T7).
 *
 * [COMP:app-web/chat-side-pane]
 */

import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Globe, Loader2 } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { getUserInfo } from "@/lib/user";
import { useCollabProvider } from "@/lib/collab/use-collab-provider";
import { fetchLinkPreview, type LinkPreview } from "@/lib/api/link-preview";
import { CollabPageEditor } from "@/components/doc/collab-page-editor";

export function PanePageBody({ pageId }: { pageId: string }) {
  const collab = useCollabProvider(pageId);
  const user = useMemo(() => {
    const info = getUserInfo();
    return {
      id: info?.id ?? "me",
      name: info?.name?.trim() || info?.email || info?.id || "",
      avatarUrl: info?.avatarUrl,
    };
  }, []);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5" data-pane-page={pageId}>
      <CollabPageEditor collab={collab} canEdit user={user} viewId={pageId} />
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function PaneUrlBody({ url, title }: { url: string; title?: string | null }) {
  const t = useT().chatApp.sidePane;
  const [preview, setPreview] = useState<LinkPreview | null | "loading">("loading");
  useEffect(() => {
    const controller = new AbortController();
    setPreview("loading");
    void fetchLinkPreview(url, controller.signal).then((result) => {
      if (!controller.signal.aborted) setPreview(result);
    });
    return () => controller.abort();
  }, [url]);

  if (preview !== "loading" && preview?.embeddable === true) {
    return (
      <iframe
        src={url}
        title={preview.title ?? title ?? hostOf(url)}
        data-pane-url="frame"
        // The site runs in its own origin, sandboxed: no top navigation of
        // the Chat app, no access to it.
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0 bg-background"
      />
    );
  }

  const card = preview === "loading" ? null : preview;
  const heading = card?.title?.trim() || title?.trim() || hostOf(url);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-8" data-pane-url="card">
      <div className="w-full max-w-sm rounded-xl border border-border bg-muted/30 p-4">
        <div className="flex items-center gap-2.5">
          {card?.favicon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={card.favicon} alt="" className="size-6 shrink-0 rounded" />
          ) : (
            <Globe className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{heading}</p>
            <p className="truncate text-xs text-muted-foreground">{card?.siteName ?? hostOf(url)}</p>
          </div>
        </div>
        {card?.description && (
          <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{card.description}</p>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          {preview === "loading" ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              {t.urlLoading}
            </span>
          ) : (
            t.urlNotEmbeddable
          )}
        </p>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-md bg-action px-3 text-xs font-medium text-action-foreground hover:bg-action/90 sm:min-h-8"
        >
          <ExternalLink className="size-3.5" aria-hidden />
          {t.openInBrowser}
        </a>
      </div>
    </div>
  );
}
