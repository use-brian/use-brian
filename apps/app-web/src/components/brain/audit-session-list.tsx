"use client";

/**
 * Audit session list — the MASTER half of the Brain Audit master-detail,
 * rendered inside the Brain sidebar panel when the `audit` section is active.
 *
 * Lists every conversation the viewer may audit in the workspace
 * (`listAuditSessions`: own sessions on every channel + the workspace's
 * shared rooms), newest first, needle-filtered by the shared Brain `search`.
 * A row = channel dot + title + a quiet meta line (assistant · channel ·
 * relative time; a `Shared` chip on rooms). Clicking a row sets
 * `auditSessionId` in `brain-surface-context`, which the page's
 * `AuditPanel` reads. Refreshes on `BRAIN_REFRESH_EVENT` so a chat that just
 * finished a turn shows up without a reload.
 *
 * Spec: docs/architecture/features/chat-audit.md → "Session list".
 * [COMP:app-web/brain-audit]
 */

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { useT, format } from "@/lib/i18n/client";
import { listAuditSessions, type AuditSession } from "@/lib/api/sessions";
import { listWorkspaceAssistants } from "@/lib/api/views";
import { BRAIN_REFRESH_EVENT } from "@/lib/brain-events";
import { relativeTime } from "@/components/doc/comment-primitives";
import { Skeleton } from "@/components/skeleton";
import { requestSidebarClose } from "@/lib/sidebar-close";

type ChannelKey =
  | "web"
  | "telegram"
  | "slack"
  | "discord"
  | "whatsapp"
  | "wechat"
  | "msteams"
  | "email"
  | "other";

/** Fold the wire `channel_type` onto the labelled set (exported for its test). */
export function auditChannelKey(channelType: string): ChannelKey {
  switch (channelType) {
    case "web":
    case "notification":
      return "web";
    case "telegram":
      return "telegram";
    case "slack":
      return "slack";
    case "discord":
      return "discord";
    case "whatsapp":
      return "whatsapp";
    case "wechat":
      return "wechat";
    case "msteams":
      return "msteams";
    case "email":
    case "agentmail":
    case "imap":
      return "email";
    default:
      return "other";
  }
}

/** Channel accent dots reuse the entity palette tokens so nothing new is
 *  minted: web = knowledge violet, messaging = person cyan, mail = deal green. */
const CHANNEL_DOT: Record<ChannelKey, string> = {
  web: "var(--entity-knowledge)",
  telegram: "var(--entity-person)",
  slack: "var(--entity-person)",
  discord: "var(--entity-person)",
  whatsapp: "var(--entity-person)",
  wechat: "var(--entity-person)",
  msteams: "var(--entity-person)",
  email: "var(--entity-deal)",
  other: "var(--entity-other)",
};

export function AuditSessionList({
  workspaceId,
  search,
  selectedId,
  onSelect,
}: {
  workspaceId: string;
  search: string;
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  const t = useT();
  const copy = t.brainPage.audit;
  const [sessions, setSessions] = useState<AuditSession[] | null>(null);
  const [assistantNames, setAssistantNames] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const handler = () => setTick((n) => n + 1);
    window.addEventListener(BRAIN_REFRESH_EVENT, handler);
    return () => window.removeEventListener(BRAIN_REFRESH_EVENT, handler);
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    void listAuditSessions({ workspaceId, signal: controller.signal }).then(
      (rows) => {
        if (!controller.signal.aborted) setSessions(rows);
      },
    );
    return () => controller.abort();
  }, [workspaceId, tick]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void listWorkspaceAssistants(workspaceId)
      .then((list) => {
        if (cancelled) return;
        setAssistantNames(new Map(list.map((a) => [a.id, a.name])));
      })
      .catch(() => {
        // Names are a nicety; rows still render with the channel + time.
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const visible = useMemo(() => {
    if (!sessions) return null;
    const needle = search.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((s) => {
      const assistant = s.assistantId ? assistantNames.get(s.assistantId) ?? "" : "";
      return (
        s.title.toLowerCase().includes(needle) ||
        assistant.toLowerCase().includes(needle) ||
        copy.channel[auditChannelKey(s.channelType)].toLowerCase().includes(needle)
      );
    });
  }, [sessions, search, assistantNames, copy.channel]);

  if (visible === null) {
    return (
      <ul className="flex flex-col gap-1 px-1" aria-busy="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <li key={i} className="flex items-center gap-2 rounded-md px-2 py-1.5">
            <Skeleton className="size-2 rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Skeleton className="h-3" style={{ width: `${58 + ((i * 13) % 34)}%` }} />
              <Skeleton className="h-2.5 w-2/5" />
            </div>
          </li>
        ))}
      </ul>
    );
  }

  if (visible.length === 0) {
    return (
      <p className="px-2 py-3 text-[12px] text-sidebar-foreground/60">
        {copy.sidebarEmpty}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {visible.map((s) => {
        const active = selectedId === s.id;
        const channel = auditChannelKey(s.channelType);
        const assistant = s.assistantId ? assistantNames.get(s.assistantId) : undefined;
        const meta = [assistant, copy.channel[channel]].filter(Boolean).join(" · ");
        return (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => {
                onSelect(s.id);
                requestSidebarClose();
              }}
              aria-pressed={active}
              className={cn(
                "flex min-h-8 max-sm:min-h-11 w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors",
                active
                  ? "doc-nav-active text-sidebar-foreground"
                  : "text-sidebar-foreground/85 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
              )}
            >
              <span
                aria-hidden
                className="mt-[7px] inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: CHANNEL_DOT[channel] }}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  {s.shared && (
                    <span className="shrink-0 rounded-full border border-sidebar-border px-1.5 text-[9px] font-medium uppercase tracking-wide text-sidebar-foreground/60">
                      {copy.sharedBadge}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-1 text-[11px] text-sidebar-foreground/55">
                  <span className="min-w-0 truncate">{meta}</span>
                  <span aria-hidden>·</span>
                  <span className="shrink-0 tabular-nums">
                    {relativeTime(s.lastActive, copy.justNow)}
                  </span>
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
