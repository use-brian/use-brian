"use client";

/**
 * Bottom-right floating tuning chat — ported faithfully from
 * `apps/feed-web/src/components/floating-chat.tsx`
 * (docs/plans/feed-web-consolidation.md §7.3).
 *
 * Collapsed: a round chat-bubble button anchored bottom-right. Click expands.
 * Expanded: mounts `<TuningChatPanel />` — the full tuning surface (SSE,
 * voice notes, copy, retry, model picker, research-mode toggle).
 *
 * The panel STAYS MOUNTED while collapsed (hidden via classes) so the
 * conversation, streaming, and tool state survive collapse/expand cycles
 * and route changes within the feed surface. Mounted by `FeedSurfaceShell`
 * (workspace state READY) under a `chatDockSuppression` hold, so it SWAPS
 * the global `WorkspaceChrome` dock on `/w/[id]/feed/*` — two docks never
 * coexist on one surface.
 *
 * Port deltas (disposition rules §6): `useWorkspaceContext()` →
 * `useFeedWorkspace()`; the seed bus is the renamed `feed-chat-seed`
 * (`feed:chat-seed` — app-web's own `chat-seed.ts` is the DOC bus); copy via
 * `useT().feedPage.tuningChat`.
 *
 * [COMP:app-web/feed-tuning-chat]
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import { cn } from "@/lib/utils";
import {
  TuningChatPanel,
  type TuningChatPanelHandle,
} from "@/components/feed/tuning-chat-panel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FEED_CHAT_SEED_EVENT, type FeedChatSeed } from "@/lib/feed-chat-seed";
import { useT } from "@/lib/i18n/client";

type ChatAssistant = { id: string; name: string };

export function FeedFloatingChat() {
  const { workspaceId, profiles, assistants: brandAssistants } = useFeedWorkspace();
  const t = useT().feedPage.tuningChat;

  // One distinct assistant per id — a workspace may connect several
  // platforms, but they fan out from the same brand assistant. Dedupe so
  // the picker (if shown) lists each assistant once. Unconnected brand
  // voices (Create split, feed-create-split.md D7) join the list so the
  // tuning chat works with zero connections.
  const assistants = useMemo<ChatAssistant[]>(() => {
    const seen = new Map<string, ChatAssistant>();
    for (const p of profiles) {
      if (!seen.has(p.assistant.id)) {
        seen.set(p.assistant.id, { id: p.assistant.id, name: p.assistant.name });
      }
    }
    for (const a of brandAssistants) {
      if (!seen.has(a.id)) {
        seen.set(a.id, { id: a.id, name: a.name });
      }
    }
    return [...seen.values()];
  }, [profiles, brandAssistants]);

  const [expanded, setExpanded] = useState(false);
  const [activeAssistantId, setActiveAssistantId] = useState<string | null>(null);
  const chatRef = useRef<TuningChatPanelHandle>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Keep the active assistant valid as profiles load / change.
  useEffect(() => {
    if (assistants.length === 0) {
      setActiveAssistantId(null);
      return;
    }
    setActiveAssistantId((cur) =>
      cur && assistants.some((a) => a.id === cur) ? cur : assistants[0].id,
    );
  }, [assistants]);

  const activeAssistant =
    assistants.find((a) => a.id === activeAssistantId) ?? assistants[0] ?? null;

  // Surfaces (e.g. the Voice page's per-rule "Discuss") ask the chat to
  // open with a pre-filled composer via a one-shot CustomEvent.
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<FeedChatSeed>).detail;
      if (!detail?.prefill?.trim()) return;
      setExpanded(true);
      // The panel stays mounted, so the ref is live even when collapsed.
      requestAnimationFrame(() =>
        chatRef.current?.insertPrompt(detail.prefill, {
          researchMode: detail.researchMode,
        }),
      );
    }
    window.addEventListener(FEED_CHAT_SEED_EVENT, handler);
    return () => window.removeEventListener(FEED_CHAT_SEED_EVENT, handler);
  }, []);

  // Collapse on Escape or outside click. The model picker renders its
  // menu in a portal outside `panelRef`, so a naive contains() check
  // would collapse the panel on every dropdown interaction — exempt the
  // Select popup + standard overlay roles.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (
        target.closest('[data-slot="select-content"]') ||
        target.closest('[role="listbox"]') ||
        target.closest('[role="option"]') ||
        target.closest('[role="dialog"]')
      ) {
        return;
      }
      const node = panelRef.current;
      if (!node) return;
      if (node.contains(target as Node)) return;
      setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointerDown);
    };
  }, [expanded]);

  // No connected assistant yet — nothing to chat with. The feed home's
  // connect-account onboarding owns the empty state, so render nothing here.
  if (!activeAssistant) return null;

  return (
    <div ref={panelRef} className="fixed bottom-5 right-5 z-40 flex flex-col items-end gap-3">
      {/* Expanded panel — ALWAYS mounted, scales in from the FAB.
          `inert` while collapsed keeps the hidden composer/buttons out of
          the tab order and pointer flow without unmounting (so the
          conversation + stream survive). */}
      <div
        aria-hidden={!expanded}
        inert={!expanded}
        className={cn(
          "absolute bottom-full right-0 mb-3 origin-bottom-right",
          "w-[min(420px,calc(100vw-2.5rem))] h-[min(640px,75vh)]",
          "flex flex-col overflow-hidden",
          "transition-[opacity,transform] duration-200 ease-out",
          expanded
            ? "opacity-100 scale-100 translate-y-0 pointer-events-auto"
            : "opacity-0 scale-95 translate-y-2 pointer-events-none",
        )}
      >
        {assistants.length > 1 ? (
          <div className="shrink-0 mb-2 flex justify-end">
            <Select
              value={activeAssistant.id}
              onValueChange={(v) => { if (v) setActiveAssistantId(v); }}
            >
              <SelectTrigger
                size="sm"
                tabIndex={expanded ? 0 : -1}
                className="text-xs gap-1.5 bg-card/95 shadow-lg backdrop-blur"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent side="top" align="end" alignItemWithTrigger={false} className="w-auto min-w-48">
                {assistants.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <span className="text-sm">{a.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <div className="min-h-0 flex-1">
          {/* Keyed by assistant so switching resumes that assistant's session. */}
          <TuningChatPanel
            key={activeAssistant.id}
            ref={chatRef}
            assistantId={activeAssistant.id}
            assistantName={activeAssistant.name}
            workspaceId={workspaceId}
            onClose={() => setExpanded(false)}
          />
        </div>
      </div>

      {/* FAB — fades + scales out when the panel opens. */}
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-hidden={expanded}
        aria-label={t.openAria}
        tabIndex={expanded ? -1 : 0}
        className={cn(
          "inline-flex h-14 w-14 items-center justify-center rounded-full",
          "bg-primary text-primary-foreground shadow-lg",
          "transition-[opacity,transform] duration-200 ease-out hover:bg-primary/90 active:scale-95",
          expanded ? "opacity-0 scale-90 pointer-events-none" : "opacity-100 scale-100",
        )}
      >
        <ChatBubbleIcon />
      </button>
    </div>
  );
}

function ChatBubbleIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
