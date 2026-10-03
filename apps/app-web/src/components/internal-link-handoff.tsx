"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildAliasInternalLink,
  buildCanonicalInternalLink,
  buildNativeOpenUrl,
  parseInternalLinkDestination,
  parseIdHandoffPath,
  type InternalLinkDestination,
} from "@use-brian/shared/desktop-links";
import { Button } from "@/components/ui/button";
import {
  authorizeStableInternalLink,
  InternalLinkApiError,
  resolveInternalLink,
} from "@/lib/api/internal-links";
import { useT } from "@/lib/i18n/client";

export type InternalLinkHandoffInput =
  | Readonly<{ kind: "aliases"; workspaceAlias: string; pageAlias?: string }>
  | Readonly<{ kind: "ids"; path: string }>;

export function isDesktopHandoffPlatform(navigatorValue: Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints">): boolean {
  const ua = navigatorValue.userAgent.toLowerCase();
  if (/android|iphone|ipad|ipod|mobile/.test(ua)) return false;
  if (navigatorValue.platform === "MacIntel" && navigatorValue.maxTouchPoints > 1) return false;
  return /mac|win|linux|x11/.test(`${navigatorValue.platform} ${ua}`.toLowerCase());
}

function attemptNativeHandoff(url: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noreferrer";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
}

function continuationUrl(destination: InternalLinkDestination): string {
  const url = new URL(window.location.href);
  url.searchParams.set("web", "1");
  if (destination.blockId) url.searchParams.set("block", destination.blockId);
  else url.searchParams.delete("block");
  url.hash = "";
  return url.href;
}

/** Resolve only after browser authentication, then rebuild a local stable route. */
export async function resolveBrowserCanonicalPath(
  destination: InternalLinkDestination,
  appOrigin = window.location.origin,
): Promise<string> {
  let workspaceId: string;
  let pageId: string | undefined;
  if (destination.kind === "aliases") {
    const value = await resolveInternalLink(destination.workspaceAlias, destination.pageAlias);
    workspaceId = value.workspaceId;
    pageId = value.pageId;
  } else {
    const allowed = await authorizeStableInternalLink(destination);
    if (!allowed) throw new InternalLinkApiError("Not found", 404);
    workspaceId = destination.workspaceId;
    pageId = destination.pageId;
  }
  const stable = new URL(buildCanonicalInternalLink({
    appOrigin,
    workspaceId,
    pageId,
    blockId: destination.blockId,
  }));
  return `${stable.pathname}${stable.hash}`;
}

/** Public shell: no target lookup occurs until explicit browser continuation. */
export function InternalLinkHandoff({ input }: { input: InternalLinkHandoffInput }) {
  const t = useT().internalLinks;
  const attempted = useRef(false);
  const [status, setStatus] = useState<"ready" | "resolving" | "not-found">("ready");

  const destination = useMemo<InternalLinkDestination | null>(() => {
    if (typeof window === "undefined") return null;
    const block = new URLSearchParams(window.location.search).get("block") ?? undefined;
    if (input.kind === "aliases") {
      try {
        const url = buildAliasInternalLink({
          appOrigin: window.location.origin,
          workspaceAlias: input.workspaceAlias,
          pageAlias: input.pageAlias,
          blockId: block ?? (window.location.hash.startsWith("#b-") ? window.location.hash.slice(3) : undefined),
        });
        return parseInternalLinkDestination(url);
      } catch {
        return null;
      }
    }
    const parsed = parseIdHandoffPath(input.path, window.location.origin);
    if (!parsed || (block && parsed.blockId && block !== parsed.blockId)) return null;
    return block && !parsed.blockId
      ? parseIdHandoffPath(`${new URL(parsed.sourceUrl).pathname}#b-${block}`, window.location.origin)
      : parsed;
  }, [input]);

  const webMode = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("web") === "1";

  useEffect(() => {
    if (!destination || webMode || attempted.current || !isDesktopHandoffPlatform(navigator)) return;
    attempted.current = true;
    attemptNativeHandoff(buildNativeOpenUrl(destination.sourceUrl));
  }, [destination, webMode]);

  useEffect(() => {
    if (!destination || !webMode) return;
    let live = true;
    setStatus("resolving");
    void (async () => {
      try {
        const canonicalPath = await resolveBrowserCanonicalPath(destination);
        if (!live) return;
        window.location.replace(canonicalPath);
      } catch (error) {
        if (!live) return;
        // A 401 has already started hosted/OSS authentication through authFetch.
        if (error instanceof InternalLinkApiError && error.status === 401) return;
        setStatus("not-found");
      }
    })();
    return () => { live = false; };
  }, [destination, webMode]);

  if (!destination) {
    return <HandoffFrame title={t.handoffTitle} body={t.browserNotFound} />;
  }

  const openDesktop = () => attemptNativeHandoff(buildNativeOpenUrl(destination.sourceUrl));
  const continueBrowser = () => window.location.assign(continuationUrl(destination));

  return (
    <HandoffFrame
      title={t.handoffTitle}
      body={status === "resolving" ? t.browserResolving : status === "not-found" ? t.browserNotFound : t.handoffDescription}
    >
      <div className="mt-6 grid w-full gap-3 sm:grid-cols-2">
        <Button className="max-sm:min-h-11" onClick={openDesktop}>{t.openDesktop}</Button>
        <Button className="max-sm:min-h-11" variant="outline" onClick={continueBrowser}>{t.continueBrowser}</Button>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">{t.desktopUnavailableHint}</p>
    </HandoffFrame>
  );
}

function HandoffFrame({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-background p-4 text-foreground">
      <section className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 text-center shadow-sm sm:p-8">
        <div aria-hidden className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-action text-lg font-semibold text-action-foreground">B</div>
        <h1 className="mt-5 text-xl font-semibold">{title}</h1>
        <p role="status" className="mt-3 text-sm leading-relaxed text-muted-foreground">{body}</p>
        {children}
      </section>
    </main>
  );
}
