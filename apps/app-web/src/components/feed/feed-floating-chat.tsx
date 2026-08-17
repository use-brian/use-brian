"use client";

/**
 * Bottom-right Feed control chat — evolved from
 * `apps/feed-web/src/components/floating-chat.tsx`
 * (docs/plans/feed-web-consolidation.md §7.3).
 *
 * Collapsed: the app-standard launcher pill anchored bottom-right — the
 * assistant's creature avatar beside an explicit `Create with {assistant}`
 * label. The persistent Feed top bar can open the same panel. Click expands.
 * Expanded: mounts `<TuningChatPanel />` — the full tuning surface (SSE,
 * shared live recorder, copy, retry, model picker, research-mode toggle) — anchored
 * flush to the corner (the launcher hides while open), global-dock idiom. Its
 * top edge, left edge, and top-left corner resize up-and-left, with the chosen
 * size persisted across Feed visits.
 *
 * The panel STAYS MOUNTED while collapsed (hidden via classes) so the
 * conversation, streaming, and tool state survive collapse/expand cycles
 * and route changes within the Feed surface. Every non-post route uses the
 * established `channel_id='plan'` / `mode='plan'` session as one master
 * control conversation. Mounted by `FeedSurfaceShell`
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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { usePathname } from "next/navigation";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import { feedPostIdFromPathname } from "@/lib/feed-nav";
import { cn } from "@/lib/utils";
import {
  TuningChatPanel,
  type TuningChatActivity,
  type TuningChatPanelHandle,
} from "@/components/feed/tuning-chat-panel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FEED_CHAT_OPEN_EVENT,
  FEED_CHAT_SEED_EVENT,
  type FeedChatSeed,
} from "@/lib/feed-chat-seed";
import { ensurePlanSession } from "@/lib/api/feed";
import { AssistantAvatar } from "@/components/assistant-avatar";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import {
  DockRecorderButton,
  DockRecorderNotice,
  DockRecorderRecovery,
  DockRecorderStrip,
} from "@/components/chrome/dock-recorder";
import { useGlobalDockRecorder } from "@/lib/recorder/dock-recorder-bridge";

type ChatAssistant = { id: string; name: string; iconSeed?: number };

const SIZE_STORAGE_KEY = "feed-chat-size";
const DEFAULT_CHAT_SIZE = { w: 460, h: 640 };
const MIN_CHAT_W = 340;
const MIN_CHAT_H = 420;
/** Existing wire id retained so prior Plan history becomes the master Feed chat. */
const FEED_CONTROL_CHANNEL_ID = "plan";

type ChatSize = { w: number; h: number };

const IDLE_CHAT_ACTIVITY: TuningChatActivity = {
  isStreaming: false,
  streamingText: "",
  activeLabel: null,
};

/** Label priority shared with the global dock's collapsed pill. */
export function feedChatLauncherLabel(
  activity: TuningChatActivity,
  idleLabel: string,
  thinkingLabel: string,
): string {
  if (!activity.isStreaming) return idleLabel;
  return (
    activity.activeLabel ??
    collapseFeedActivityText(activity.streamingText) ??
    thinkingLabel
  );
}

/** Squash a streamed Markdown reply into one compact launcher line. */
function collapseFeedActivityText(text: string): string | undefined {
  const trimmed = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*[#>\-*+]+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!trimmed) return undefined;
  const max = 80;
  return trimmed.length > max ? trimmed.slice(-max) : trimmed;
}

/** Keep the floating panel usable and entirely inside the live viewport. */
function clampChatSize(size: ChatSize): ChatSize {
  const hasWindow = typeof window !== "undefined";
  const maxW = hasWindow ? Math.max(MIN_CHAT_W, window.innerWidth - 32) : size.w;
  const maxH = hasWindow
    ? Math.max(MIN_CHAT_H, Math.round(window.innerHeight * 0.92))
    : size.h;
  return {
    w: Math.round(Math.max(MIN_CHAT_W, Math.min(size.w, maxW))),
    h: Math.round(Math.max(MIN_CHAT_H, Math.min(size.h, maxH))),
  };
}

export function FeedFloatingChat() {
  const { workspaceId, profiles, assistants: brandAssistants } = useFeedWorkspace();
  const t = useT().feedPage.tuningChat;
  // The collapsed pill reuses the global dock's surface nudge verbatim, so
  // the two docks read as one affordance across the surface swap.
  const tChat = useT().chat;
  // Feed replaces only the global CHAT chrome. Rehost its one persistent
  // recorder controller so capture survives entering/leaving this surface.
  const dockRecorder = useGlobalDockRecorder();

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

  // A selected post owns a focused Refine conversation. Everywhere else the
  // Feed dock is one master control conversation; route changes must never
  // silently swap its history.
  const pathname = usePathname() ?? "";
  const postEditorOwnsChat = feedPostIdFromPathname(pathname) !== null;

  const [expanded, setExpanded] = useState(false);
  const [activity, setActivity] = useState<TuningChatActivity>(IDLE_CHAT_ACTIVITY);
  const [activeAssistantId, setActiveAssistantId] = useState<string | null>(null);
  const [controlSession, setControlSession] = useState<{
    assistantId: string;
    sessionId: string;
  } | null>(null);
  const chatRef = useRef<TuningChatPanelHandle>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Match the app-wide dock's resize direction and viewport clamps. Feed owns
  // a separate persisted preference because both docks stay mounted during
  // the suppression swap and must not race to overwrite one storage key.
  const [chatSize, setChatSize] = useState<ChatSize>(() => {
    if (typeof window === "undefined") return DEFAULT_CHAT_SIZE;
    try {
      const raw = localStorage.getItem(SIZE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<ChatSize>;
        if (typeof parsed?.w === "number" && typeof parsed?.h === "number") {
          return clampChatSize({ w: parsed.w, h: parsed.h });
        }
      }
    } catch {
      /* fall through to the default */
    }
    return clampChatSize(DEFAULT_CHAT_SIZE);
  });
  const resizeRef = useRef<{
    x: number;
    y: number;
    w: number;
    h: number;
    axis: "x" | "y" | "xy";
  } | null>(null);
  const startResize = useCallback(
    (axis: "x" | "y" | "xy") =>
      (event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        resizeRef.current = {
          x: event.clientX,
          y: event.clientY,
          w: chatSize.w,
          h: chatSize.h,
          axis,
        };
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* capture unsupported; pointer events still fire on the handle */
        }
      },
    [chatSize.h, chatSize.w],
  );
  const moveResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeRef.current;
    if (!start) return;
    // The panel is anchored bottom-right, so moving left/up increases it.
    const dx = start.x - event.clientX;
    const dy = start.y - event.clientY;
    setChatSize(
      clampChatSize({
        w: start.axis === "y" ? start.w : start.w + dx,
        h: start.axis === "x" ? start.h : start.h + dy,
      }),
    );
  }, []);
  const endResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    resizeRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* nothing captured */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(chatSize));
    } catch {
      /* private mode; persistence is non-fatal */
    }
  }, [chatSize]);

  useEffect(() => {
    const onResize = () => setChatSize((size) => clampChatSize(size));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
  const controlSessionId =
    activeAssistant && controlSession?.assistantId === activeAssistant.id
      ? controlSession.sessionId
      : null;
  const recorderOwnsPill =
    dockRecorder?.phase.kind === "latched" ||
    dockRecorder?.phase.kind === "finishing";
  const isActive = activity.isStreaming;
  const idleLauncherLabel = format(t.launcher, { name: activeAssistant?.name ?? "" });
  const launcherLabel = feedChatLauncherLabel(
    activity,
    idleLauncherLabel,
    tChat.thinking,
  );

  // Provision the mode='plan' row before the master composer can send. The
  // route name stays /plan-session for wire compatibility, but this one row
  // is now the control conversation across every non-post Feed surface.
  useEffect(() => {
    if (!activeAssistant) {
      setControlSession(null);
      return;
    }
    let cancelled = false;
    setControlSession((current) =>
      current?.assistantId === activeAssistant.id ? current : null,
    );
    void ensurePlanSession(activeAssistant.id).then((result) => {
      if (cancelled || !result) return;
      setControlSession({
        assistantId: activeAssistant.id,
        sessionId: result.sessionId,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [activeAssistant]);

  // The persistent top bar opens the current conversation unchanged. Context
  // actions (e.g. Voice "Discuss" and Plan this month) open it and seed a
  // draft instruction into the composer.
  useEffect(() => {
    function openHandler() {
      setExpanded(true);
    }
    function seedHandler(e: Event) {
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
    window.addEventListener(FEED_CHAT_OPEN_EVENT, openHandler);
    window.addEventListener(FEED_CHAT_SEED_EVENT, seedHandler);
    return () => {
      window.removeEventListener(FEED_CHAT_OPEN_EVENT, openHandler);
      window.removeEventListener(FEED_CHAT_SEED_EVENT, seedHandler);
    };
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
  if (!activeAssistant || postEditorOwnsChat) return null;

  return (
    <div
      ref={panelRef}
      data-feed-chat-channel={FEED_CONTROL_CHANNEL_ID}
      className="fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2"
    >
      {/* Expanded panel — ALWAYS mounted, anchored flush to the corner like
          the global dock (the launcher pill hides while open, so a
          `bottom-full` perch would just strand an empty strip below).
          `inert` while collapsed keeps the hidden composer/buttons out of
          the tab order and pointer flow without unmounting (so the
          conversation + stream survive). */}
      <div
        aria-hidden={!expanded}
        inert={!expanded}
        style={{ width: chatSize.w, height: chatSize.h }}
        className={cn(
          "absolute right-0 bottom-0 origin-bottom-right",
          "max-w-[calc(100vw-2rem)] max-h-[92dvh]",
          "flex flex-col overflow-hidden",
          "transition-[opacity,transform] duration-200 ease-out",
          expanded
            ? "opacity-100 scale-100 translate-y-0 pointer-events-auto"
            : "opacity-0 scale-95 translate-y-2 pointer-events-none",
        )}
      >
        {/* The same up-and-left resize affordance as the app-wide dock. */}
        <div
          role="separator"
          aria-label={tChat.resizeHandle}
          aria-orientation="horizontal"
          onPointerDown={startResize("xy")}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          className="group/resize absolute left-0 top-0 z-20 size-3.5 cursor-nwse-resize"
        >
          <span
            aria-hidden
            className="absolute left-1 top-1 size-1.5 rounded-tl-sm border-l-2 border-t-2 border-muted-foreground/30 transition-colors group-hover/resize:border-primary/70"
          />
        </div>
        <div
          aria-hidden
          onPointerDown={startResize("y")}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          className="absolute left-3.5 right-0 top-0 z-10 h-1.5 cursor-ns-resize"
        />
        <div
          aria-hidden
          onPointerDown={startResize("x")}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          className="absolute left-0 top-3.5 bottom-0 z-10 w-1.5 cursor-ew-resize"
        />

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
          {/* One fixed Feed control session per assistant. It is deliberately
              not keyed by route, so navigation never swaps the conversation. */}
          <TuningChatPanel
            key={`${activeAssistant.id}:${FEED_CONTROL_CHANNEL_ID}`}
            ref={chatRef}
            assistantId={activeAssistant.id}
            assistantName={activeAssistant.name}
            iconSeed={activeAssistant.iconSeed}
            workspaceId={workspaceId}
            channelId={FEED_CONTROL_CHANNEL_ID}
            sessionId={controlSessionId ?? undefined}
            ready={controlSessionId !== null}
            onClose={() => setExpanded(false)}
            onActivityChange={setActivity}
            dockRecorder={expanded ? dockRecorder ?? undefined : undefined}
            ownsDockRecorderTarget
          />
        </div>
      </div>

      {!expanded && dockRecorder ? (
        <>
          <DockRecorderRecovery rec={dockRecorder} />
          <DockRecorderNotice rec={dockRecorder} />
          <DockRecorderStrip rec={dockRecorder} />
        </>
      ) : null}

      {/* Launcher — the app-standard compact pill (chrome/floating-chat.tsx
          idiom): the assistant's creature avatar beside a short text nudge.
          Fades + scales out when the panel opens. The universal recorder rides
          beside it exactly as it does beside the global launcher. */}
      {!recorderOwnsPill ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-hidden={expanded}
            aria-live={isActive ? "polite" : undefined}
            aria-label={t.openAria}
            tabIndex={expanded ? -1 : 0}
            className={cn(
              "inline-flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-3.5 shadow-lg backdrop-blur",
              "max-w-[min(260px,calc(100vw-3rem))] text-left text-sm",
              isActive
                ? "border border-primary/40 bg-primary/10 text-foreground ring-2 ring-primary/20"
                : "border border-border bg-background/90 text-foreground/80 hover:bg-accent hover:text-foreground",
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
            <span
              className={cn(
                "min-w-0 truncate",
                isActive ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {launcherLabel}
            </span>
          </button>
          {dockRecorder ? (
            <DockRecorderButton
              rec={dockRecorder}
              variant="floating"
              className={cn(
                "transition-[opacity,transform] duration-200 ease-out",
                expanded
                  ? "opacity-0 scale-95 pointer-events-none"
                  : "opacity-100 scale-100",
              )}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
