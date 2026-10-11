"use client";

/**
 * Every link in a Chat transcript opens in the side pane (chat-parity D9).
 *
 * Page cards and in-app page links, citations and tool-step URLs, the
 * markdown `a` renderer, assistant file chips, user attachments and the Work
 * tab's pin rows all call `openInPane({kind, ref})` instead of
 * `router.push`, `target="_blank"`, a download or a modal. Nothing in the
 * transcript navigates away or opens a new browser tab; the explicit "Open
 * in browser" / "Open full page" actions on a tab are the only ways out.
 *
 * The router is a React context so the chrome the floating dock shares
 * (`chat-activity.tsx`, `chat-file-attachment.tsx`, `message-attachment-card`)
 * routes only where a pane exists: without a `PaneLinkProvider` (the dock,
 * which keeps its behaviour, T12) every one of them renders exactly as
 * before.
 *
 * Spec: docs/architecture/features/chat-app.md -> "Side pane" -> "Links".
 *
 * [COMP:app-web/chat-link-routing]
 */

import { createContext, useContext, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { pageIdFromInAppHref } from "@/lib/doc-page-url";
import type { PaneRef } from "@/lib/chat-pane-tabs";

type PaneLinks = {
  /** Open (or focus) a reference in the open chat's side pane. */
  open: (ref: PaneRef) => void;
};

const PaneLinkContext = createContext<PaneLinks | null>(null);

export function PaneLinkProvider({
  openInPane,
  children,
}: {
  openInPane: (ref: PaneRef) => void;
  children: ReactNode;
}) {
  return <PaneLinkContext.Provider value={{ open: openInPane }}>{children}</PaneLinkContext.Provider>;
}

/** The pane router, or null where no pane exists (the dock). */
export function usePaneLinks(): PaneLinks | null {
  return useContext(PaneLinkContext);
}

/**
 * What a transcript href opens: an in-app page (`/w/<w>/p/<id>`, `/p/<id>`,
 * a bare page id) becomes a `page` tab, an `http(s)` URL a `url` tab.
 * Anything else (`mailto:`, `tel:`, an anchor) has no pane form.
 */
export function paneRefForHref(href: string | undefined, title?: string | null): PaneRef | null {
  if (!href) return null;
  const pageId = pageIdFromInAppHref(href);
  if (pageId) return { kind: "page", pageId, ...(title ? { title } : {}) };
  if (/^https?:\/\//i.test(href)) return { kind: "url", url: href, ...(title ? { title } : {}) };
  return null;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
};

/** A best guess at a stored file's type from its name (pins carry no MIME). */
export function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

/** The pane form of a Work-tab pin row, or null for kinds the pane does not hold. */
export function paneRefForPin(pin: {
  kind: string;
  refId: string | null;
  url: string | null;
  label: string | null;
}): PaneRef | null {
  if (pin.kind === "page" && pin.refId) return { kind: "page", pageId: pin.refId, title: pin.label };
  if (pin.kind === "url" && pin.url) return { kind: "url", url: pin.url, title: pin.label };
  if (pin.kind === "file" && pin.refId) {
    const name = pin.label ?? pin.refId;
    return { kind: "file", fileId: pin.refId, name, mime: mimeFromName(name), source: "durable" };
  }
  return null;
}

/**
 * The transcript's markdown `a` renderer: a pane-able href opens in the
 * pane (any click, modifier or not); anything else keeps its plain anchor.
 */
export function ChatPaneLink({
  href,
  children,
}: { href?: string; children?: ReactNode }) {
  const links = usePaneLinks();
  const ref = paneRefForHref(href);
  if (!links || !ref) {
    // No pane (the dock), or nothing pane-able (`mailto:`): a plain link.
    return <a href={href}>{children}</a>;
  }
  const open = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    links.open(ref);
  };
  return (
    <a
      href={href}
      data-pane-link={ref.kind}
      onClick={open}
      onAuxClick={open}
      className="cursor-pointer"
    >
      {children}
    </a>
  );
}

/**
 * A URL in shared chat chrome (citations, tool steps): a `url` tab where a
 * pane exists, the classic new-tab link where none does (the dock).
 */
export function PaneUrlAnchor({
  url,
  tabTitle,
  className,
  children,
  iconFirst = false,
}: {
  url: string;
  /** What the opened tab is called (a citation's title); the hover shows the URL. */
  tabTitle?: string;
  className?: string;
  children: ReactNode;
  /** A leading external-link glyph (citation chips). */
  iconFirst?: boolean;
}) {
  const links = usePaneLinks();
  const icon = iconFirst ? <ExternalLink className="size-2.5 shrink-0" aria-hidden /> : null;
  if (!links) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" title={url} className={className}>
        {icon}
        {children}
      </a>
    );
  }
  const open = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    links.open({ kind: "url", url, ...(tabTitle && tabTitle !== url ? { title: tabTitle } : {}) });
  };
  return (
    <a href={url} title={url} className={className} data-pane-link="url" onClick={open} onAuxClick={open}>
      {icon}
      {children}
    </a>
  );
}
