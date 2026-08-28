"use client";

/**
 * Feed surface shell — the client wrapper every `/w/[id]/feed/*` route
 * renders inside (mounted by `feed/layout.tsx`).
 *
 * Mounts the shared operator top bar (`[COMP:app-web/operator-topbar]`)
 * above the readiness gate — chrome on every feed state — and owns the feed
 * pane's one `overflow-y-auto` scroll container beneath it.
 *
 * Owns the `FeedProfilesProvider` and gates children on its readiness so
 * ported feed pages keep feed-web's assumption that the workspace context is
 * synchronously available (docs/plans/feed-web-consolidation.md §4). Once the
 * workspace state is READY it also mounts the feed-scoped tuning-chat dock
 * (`<FeedFloatingChat />`) under a `chatDockSuppression` hold — replacing
 * feed-web's workspace-layout mount — so every feed route SWAPS the global
 * `WorkspaceChrome` dock for the feed dock; two docks never coexist. The
 * loading/error gate renders neither the dock nor the hold.
 *
 * [COMP:app-web/feed-surface-shell]
 */

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { MessageSquareText, Plus } from "lucide-react";
import {
  FeedProfilesProvider,
  useFeedWorkspaceState,
} from "@/contexts/feed-profiles-context";
import { chatDockSuppression } from "@/lib/chat-dock-suppress";
import { FeedFloatingChat } from "@/components/feed/feed-floating-chat";
import { PlatformIcon } from "@/components/feed/platform-icon";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  FEED_PLATFORMS,
  defaultFeedPlatform,
  feedPath,
  feedPostIdFromPathname,
  type FeedPlatform,
} from "@/lib/feed-nav";
import { requestFeedChatOpen } from "@/lib/feed-chat-seed";

export function FeedSurfaceShell(props: {
  workspaceId: string;
  children: ReactNode;
}) {
  // Retry remounts the provider (fresh fetch) via the key bump.
  const [epoch, setEpoch] = useState(0);
  return (
    <FeedProfilesProvider key={epoch} workspaceId={props.workspaceId}>
      <div className="flex h-full min-h-0 flex-col">
        {/* Chrome — the shared operator top bar, ABOVE the readiness gate so
            it renders on every feed state (loading / error / onboarding
            included) ([COMP:app-web/operator-topbar]). The wrapper below it
            owns the feed pane's one scroll container; pages with their own
            full-height scroller (Voice, draft detail) fill it with `h-full`
            so the outer never overflows. */}
        <OperatorTopbar
          app="feed"
          right={
            <>
              <FeedNewPostTopbarAction />
              <FeedChatTopbarAction />
            </>
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <FeedReadyGate onRetry={() => setEpoch((e) => e + 1)}>
            {props.children}
          </FeedReadyGate>
        </div>
      </div>
    </FeedProfilesProvider>
  );
}

/**
 * Intent-first authoring from anywhere on the surface
 * (docs/plans/feed-plan-chat-first.md P12): a platform picker defaulting to
 * the workspace's last-used platform, routing to the existing new-post form
 * — so deliberate writing never requires walking the sidebar to a
 * platform's post list. Thought-first capture stays the Plan strip's job.
 */
function FeedNewPostTopbarAction() {
  const state = useFeedWorkspaceState();
  const router = useRouter();
  const t = useT().feedPage;
  if (state.status !== "ready") return null;
  const ws = state.value;
  if (ws.profiles.length === 0 && ws.assistants.length === 0) return null;
  const preferred = defaultFeedPlatform(
    ws.workspaceId,
    ws.profiles.map((p) => p.platform),
  );
  // Last-used first; the rest keep the canonical order.
  const platforms: FeedPlatform[] = [
    preferred,
    ...FEED_PLATFORMS.filter((p) => p !== preferred),
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t.postEditor.newPost}
            className="h-8 gap-1.5 px-2.5 text-xs text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <Plus className="size-3.5" aria-hidden />
            <span>{t.postEditor.newPost}</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {platforms.map((platform) => (
          <DropdownMenuItem
            key={platform}
            onClick={() =>
              router.push(
                feedPath(ws.workspaceId, { platform, segment: "posts" }),
              )
            }
          >
            <PlatformIcon platform={platform} className="size-3.5" />
            {t.platformLabels[platform]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Persistent, explicit entry to the Feed's one master control conversation. */
function FeedChatTopbarAction() {
  const pathname = usePathname() ?? "";
  const state = useFeedWorkspaceState();
  const t = useT().feedPage.tuningChat;
  if (feedPostIdFromPathname(pathname) !== null || state.status !== "ready") {
    return null;
  }
  if (state.value.profiles.length === 0 && state.value.assistants.length === 0) {
    return null;
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={requestFeedChatOpen}
      aria-label={t.openAria}
      title={t.openAria}
      className="h-8 gap-1.5 px-2.5 text-xs text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
    >
      <MessageSquareText className="size-3.5" aria-hidden />
      <span>{t.topbarAction}</span>
    </Button>
  );
}

function FeedReadyGate(props: { onRetry: () => void; children: ReactNode }) {
  const t = useT().feedPage;
  const state = useFeedWorkspaceState();

  if (state.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <div
          role="status"
          aria-label={t.shell.loading}
          className="text-sm text-muted-foreground animate-pulse"
        >
          {t.shell.loading}
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <div className="text-sm text-muted-foreground">{t.shell.loadError}</div>
        <Button variant="outline" size="sm" onClick={props.onRetry}>
          {t.shell.retry}
        </Button>
      </div>
    );
  }

  return (
    <>
      {props.children}
      <FeedDockHost />
    </>
  );
}

/**
 * The feed-scoped tuning dock + its global-dock suppression hold. Mounted
 * only in the READY branch, so the hold's lifetime is exactly the dock's:
 * while any feed route is on screen the `WorkspaceChrome` dock hides
 * (display:none, stays mounted) and the feed dock stands in for it.
 */
function FeedDockHost() {
  useEffect(() => chatDockSuppression.suppress(), []);
  return <FeedFloatingChat />;
}
