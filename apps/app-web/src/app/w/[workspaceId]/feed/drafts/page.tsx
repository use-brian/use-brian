"use client";

/**
 * Workspace-level Drafts route — the Create group's drafting home
 * (docs/plans/feed-create-split.md D8). Platform chips over the existing
 * `DraftSessionsList` (`[COMP:app-web/feed-draft-sessions]`), which renders
 * the selected target platform's sessions; the legacy per-platform
 * `/feed/[platform]/draft-sessions` routes stay as deep links.
 *
 * The selected platform rides `?platform=` (deep-linkable, chip-switchable);
 * default is the first CONNECTED platform, else Instagram (the first target
 * in app-bar order).
 */

import { Suspense, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import { DraftSessionsList } from "@/components/feed/draft-sessions-list";
import {
  FEED_PLATFORMS,
  defaultFeedPlatform,
  feedPath,
  isFeedPlatform,
  type FeedPlatform,
} from "@/lib/feed-nav";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

function DraftsIndex() {
  const params = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const team = useFeedWorkspace();
  const t = useT().feedPage;

  // Default = first PICKED platform (the home first-run step, D14), else
  // first connected, else Instagram. The stored pick applies in an effect
  // (localStorage) so SSR and the first client paint stay identical; a
  // `?platform=` deep link always wins.
  const [pickDefault, setPickDefault] = useState<FeedPlatform | null>(null);
  useEffect(() => {
    setPickDefault(
      defaultFeedPlatform(
        params.workspaceId,
        team.profiles.map((p) => p.platform),
      ),
    );
  }, [params.workspaceId, team.profiles]);

  const fromUrl = searchParams.get("platform");
  const platform: FeedPlatform = isFeedPlatform(fromUrl)
    ? fromUrl
    : (pickDefault ?? team.profiles[0]?.platform ?? FEED_PLATFORMS[0]);

  function selectPlatform(next: FeedPlatform) {
    router.replace(
      `${feedPath(params.workspaceId, { segment: "drafts" })}?platform=${next}`,
    );
  }

  return (
    <div className="pt-6">
      <nav
        aria-label={t.draftSessions.platformFilterAria}
        className="px-6 md:px-10 max-w-7xl mx-auto flex flex-wrap items-center gap-1.5"
      >
        {FEED_PLATFORMS.map((p) => {
          const active = p === platform;
          return (
            <button
              key={p}
              type="button"
              onClick={() => selectPlatform(p)}
              aria-pressed={active}
              className={cn(
                "press h-8 rounded-full border px-3.5 text-[13px] font-medium transition-colors",
                active
                  ? "border-transparent bg-foreground text-background"
                  : "border-border bg-background/60 text-muted-foreground hover:bg-accent",
              )}
            >
              {t.platformLabels[p]}
            </button>
          );
        })}
      </nav>
      {/* Remount per platform so list state (filters, composer) resets. */}
      <DraftSessionsList key={platform} platform={platform} />
    </div>
  );
}

export default function FeedDraftsPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">…</div>}>
      <DraftsIndex />
    </Suspense>
  );
}
