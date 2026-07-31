"use client";

/**
 * Bottom-right floating tuning chat — ported faithfully from
 * `apps/feed-web/src/components/floating-chat.tsx`
 * (docs/plans/feed-web-consolidation.md §7.3).
 *
 * Collapsed: the app-standard launcher pill anchored bottom-right — the
 * assistant's creature avatar beside the global dock's "Ask anything" nudge,
 * in the exact chrome `WorkspaceChrome`'s dock uses (`chrome/floating-chat.tsx`
 * launcher), so swapping docks on `/feed/*` is visually seamless. Click expands.
 * Expanded: mounts `<TuningChatPanel />` — the full tuning surface (SSE,
 * voice notes, copy, retry, model picker, research-mode toggle) — anchored
 * flush to the corner (the launcher hides while open), global-dock idiom.
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
import { usePathname } from "next/navigation";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import { feedSectionFromPathname } from "@/lib/feed-nav";
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
import { AssistantAvatar } from "@/components/assistant-avatar";
import { useT } from "@/lib/i18n/client";

type ChatAssistant = { id: string; name: string; iconSeed?: number };

export function FeedFloatingChat() {
  const { workspaceId, profiles, assistants: brandAssistants } = useFeedWorkspace();
  const t = useT().feedPage.tuningChat;
  // The collapsed pill reuses the global dock's surface nudge verbatim, so
  // the two docks read as one affordance across the surface swap.
  const tChat = useT().chat;

  // One distinct assistant per id — a workspace may connect several
  // platforms, but they fan out from the same brand assistant. Dedupe so
  // the picker (if shown) lists each assistant once. Unconnected brand
  // voices (Create split, feed-create-split.md D7) join the list so the
  // tuning chat works with zero connections.
  const assistants = useMemo<ChatAssistant[]>(() => {
    const seen = new Map<string, ChatAssistant>();
    for (const p of profiles) {
      if (!seen.has(p.assistant.id)) {
        seen.set(p.assistant.id, {
          id: p.assistant.id,
          name: p.assistant.name,
          iconSeed: p.assistant.iconSeed,
        });
      }
    }
    for (const a of brandAssistants) {
      if (!seen.has(a.id)) {
        seen.set(a.id, { id: a.id, name: a.name });
      }
    }
    return [...seen.values()];
  }, [profiles, brandAssistants]);

  // The Plan surface talks on its own sticky channel. That session carries
  // `mode='plan'`, which is what injects the `proposePlan` cardboard tool
  // (feed-revamp.md D9) — and it keeps a month of scheduling context out of
  // the voice-tuning thread the operator uses everywhere else.
  const pathname = usePathname() ?? "";
  const channelId =
    feedSectionFromPathname(pathname) === "plan" ? "plan" : "tuning";

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
    <div ref={panelRef} className="fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2">
      {/* Expanded panel — ALWAYS mounted, anchored flush to the corner like
          the global dock (the launcher pill hides while open, so a
          `bottom-full` perch would just strand an empty strip below).
          `inert` while collapsed keeps the hidden composer/buttons out of
          the tab order and pointer flow without unmounting (so the
          conversation + stream survive). */}
      <div
        aria-hidden={!expanded}
        inert={!expanded}
        className={cn(
          "absolute right-0 bottom-0 origin-bottom-right",
          "w-[min(460px,calc(100vw-2rem))] h-[min(640px,92dvh)]",
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
          {/* Keyed by assistant AND channel so switching either resumes the
              right conversation instead of grafting messages onto the last. */}
          <TuningChatPanel
            key={`${activeAssistant.id}:${channelId}`}
            ref={chatRef}
            assistantId={activeAssistant.id}
            assistantName={activeAssistant.name}
            iconSeed={activeAssistant.iconSeed}
            workspaceId={workspaceId}
            channelId={channelId}
            onClose={() => setExpanded(false)}
          />
        </div>
      </div>

      {/* Launcher — the app-standard compact pill (chrome/floating-chat.tsx
          idiom): the assistant's creature avatar beside a short text nudge.
          Fades + scales out when the panel opens. */}
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-hidden={expanded}
        aria-label={t.openAria}
        tabIndex={expanded ? -1 : 0}
        className={cn(
          "inline-flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-3.5 shadow-lg backdrop-blur",
          "max-w-[min(260px,calc(100vw-3rem))] text-left text-sm",
          "border border-border bg-background/90 text-foreground/80 hover:bg-accent hover:text-foreground",
          "transition-[opacity,transform,background-color,box-shadow] duration-200 ease-out",
          expanded ? "opacity-0 scale-95 pointer-events-none" : "opacity-100 scale-100",
        )}
      >
        <span
          aria-hidden
          className="inline-flex size-7 shrink-0 overflow-hidden rounded-full ring-1 ring-black/10 dark:ring-white/15"
        >
          <AssistantAvatar
            id={activeAssistant.id}
            name={activeAssistant.name}
            iconSeed={activeAssistant.iconSeed}
            size="sm"
          />
        </span>
        <span className="min-w-0 truncate text-muted-foreground">
          {tChat.surfacePlaceholder}
        </span>
      </button>
    </div>
  );
}
