"use client";

/**
 * Per-platform draft-sessions list — ported faithfully from
 * `apps/feed-web/src/app/w/[workspaceId]/[platform]/draft-sessions/page.tsx`
 * (docs/plans/feed-web-consolidation.md §7.4 — highest-risk phase: whole and
 * faithful, string extraction only, zero logic refactors).
 *
 * Port deltas (disposition rules §6):
 *   - `useWorkspaceContext()` → `useFeedWorkspace()`; `WorkspaceProfile` →
 *     `FeedProfile`; hrefs via `feedPath()` (`?account=` threading kept).
 *   - Inline `authFetch` RPCs → the feed SDK draft-session wrappers
 *     (`fetchFeedDraftSessions` / `createFeedDraftSession` /
 *     `deleteFeedDraftSession` / `fetchFeedSavedDrafts` /
 *     `deleteFeedPublishedPost`).
 *   - feed-web's `useConfirm().confirmAsync` → the app-root `confirmDialog()`
 *     promise (the feed-inbox precedent); `chooseAsync` (three-way discard
 *     for sessions with live posts) → the feed-scoped `useChoiceDialog()`,
 *     which keeps the in-dialog busy state.
 *   - feed-web's `TransitionLink` → `next/link` (app-web has no
 *     view-transition link; the route-progress bar covers navigation cue).
 *   - The `!profile` connect-first state links to the feed home (connect
 *     onboarding lives there), not feed-web's `/onboarding`.
 *   - All copy via `useT().feedPage` (`draftSessions` + shared
 *     `platformLabels` / `home.time*` / `inbox.kind*` keys).
 *
 * [COMP:app-web/feed-draft-sessions]
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Trash2 } from "lucide-react";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useChoiceDialog } from "@/components/feed/feed-choice-dialog";
import { useAccountPicker } from "@/components/feed/account-picker-dialog";
import {
  PostDraftPreview,
  QuotedPostPreview,
  ReplyConnector,
} from "@/components/feed/native-post-embed";
import { ExternalPostCard } from "@/components/feed/external-post-card";
import {
  createFeedDraftSession,
  deleteFeedDraftSession,
  deleteFeedPublishedPost,
  fetchFeedDraftSessions,
  fetchFeedSavedDrafts,
  type FeedDraftSessionSeed,
  type FeedDraftSessionSummary,
  type FeedProfile,
} from "@/lib/api/feed";
import {
  feedPath,
  isConnectableFeedPlatform,
  type FeedPlatform,
} from "@/lib/feed-nav";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

type FeedPageDict = ReturnType<typeof useT>["feedPage"];

type ParsedReplyUrl = {
  platform: FeedPlatform;
  handle: string;
  /** Threads shortcode (e.g. `DX4FjS5Gl5x`) or X status id. Becomes the
   *  candidate's `externalId`. The Threads-shortcode→Graph-id resolution
   *  still happens at save-draft time on the backend. */
  externalId: string;
  permalink: string;
};

/**
 * Parse a Threads / X public post URL into the structured candidate the
 * `freeform-reply` seed needs. Mirrors the server-side `parsePostUrl` in
 * `packages/api/src/feed/post-url-parser.ts` — the rule is small and
 * changes rarely, so we duplicate it client-side rather than building a
 * shared package. Returns null on unrecognised hosts / shapes.
 */
// exported for tests
export function parseReplyUrl(input: string): ParsedReplyUrl | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  if (/(?:^|\.)threads\.(?:com|net)$/i.test(host)) {
    if (parts.length < 3 || !parts[0].startsWith("@") || parts[1] !== "post") return null;
    const handle = parts[0].slice(1);
    const shortcode = parts[2];
    if (!handle || !shortcode) return null;
    return {
      platform: "threads",
      handle,
      externalId: shortcode,
      permalink: `https://www.threads.com/@${handle}/post/${shortcode}`,
    };
  }
  if (/(?:^|\.)(?:x|twitter)\.com$/i.test(host)) {
    const idx = parts.indexOf("status");
    if (idx < 1 || !/^\d+$/.test(parts[idx + 1] ?? "")) return null;
    const handle = parts[idx - 1];
    const statusId = parts[idx + 1];
    return {
      platform: "twitter",
      handle,
      externalId: statusId,
      permalink: `https://x.com/${handle}/status/${statusId}`,
    };
  }
  return null;
}

/**
 * Roll-up status applied to a session for filtering and the status badge.
 * Derived from `draftCounts` (saved drafts in the approval queue) plus
 * `draftText` (latest `proposeDrafts` candidate). The strongest "act on
 * me" signal wins so the operator never has to dig:
 *
 *   ready  > posted  > deleted  > resolved  > drafting  > in-progress
 *
 * - `ready`       — at least one saved draft is pending review.
 * - `posted`      — at least one saved draft is live on the platform.
 * - `deleted`     — nothing live, but a saved draft was posted then taken
 *                    down (distinct from `resolved` so "we published this
 *                    and pulled it" doesn't read the same as "we never
 *                    published it").
 * - `resolved`    — saved drafts but none pending, posted, or deleted (all
 *                    rejected/expired/superseded).
 * - `drafting`    — assistant has produced a candidate (`draftText` is
 *                    set) but the operator hasn't saved it to the queue
 *                    yet. Card body shows the candidate, so badging it
 *                    "in progress" reads as a contradiction.
 * - `in-progress` — chat-only session, no candidate yet.
 */
export type SessionStatus =
  | "ready"
  /** A saved draft was approved for MANUAL posting and sits in the
   *  ready-to-post queue (docs/plans/feed-create-split.md D2). */
  | "ready-to-post"
  | "posted"
  | "deleted"
  | "resolved"
  | "drafting"
  | "in-progress";

// exported for tests
export function deriveStatus(
  s: Pick<FeedDraftSessionSummary, "draftCounts" | "draftText">,
): SessionStatus {
  const { pending, ready, posted, rejected, deleted } = s.draftCounts;
  if (pending > 0) return "ready";
  if (ready > 0) return "ready-to-post";
  if (posted > 0) return "posted";
  if (deleted > 0) return "deleted";
  if (rejected > 0) return "resolved";
  if (s.draftText) return "drafting";
  return "in-progress";
}

const STATUS_BADGE_CLASS: Record<SessionStatus, string> = {
  ready: "bg-primary/15 text-primary ring-1 ring-primary/30",
  "ready-to-post": "bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30",
  drafting: "bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30",
  "in-progress": "bg-muted text-muted-foreground ring-1 ring-border",
  posted: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30",
  deleted: "bg-destructive/15 text-destructive ring-1 ring-destructive/30",
  resolved: "bg-muted text-muted-foreground ring-1 ring-border",
};

function statusLabel(t: FeedPageDict["draftSessions"], status: SessionStatus): string {
  switch (status) {
    case "ready":
      return t.statusReady;
    case "ready-to-post":
      return t.statusReadyManual;
    case "drafting":
      return t.statusDrafting;
    case "in-progress":
      return t.statusInProgress;
    case "posted":
      return t.statusPosted;
    case "deleted":
      return t.statusDeleted;
    case "resolved":
      return t.statusResolved;
  }
}

/**
 * Per-status card chrome. Tints the card background + border so the same
 * grid scans more like a status board than a uniform list — the operator
 * sees "two reds need my attention" without reading the badge labels.
 *
 * Tints are deliberately faint (5-7% alpha) so the card content (parent
 * post embed, draft body) stays readable. The hover state lifts to a
 * stronger tint to reinforce the click affordance.
 */
const STATUS_CARD_CHROME: Record<SessionStatus, string> = {
  ready:
    "bg-primary/[0.06] border-primary/25 hover:bg-primary/[0.10] hover:border-primary/40",
  "ready-to-post":
    "bg-emerald-500/[0.05] border-emerald-500/20 hover:bg-emerald-500/[0.09] hover:border-emerald-500/35",
  drafting:
    "bg-amber-500/[0.05] border-amber-500/25 hover:bg-amber-500/[0.10] hover:border-amber-500/40",
  "in-progress": "bg-card border-border hover:bg-accent/40 hover:border-primary/30",
  posted:
    "bg-emerald-500/[0.06] border-emerald-500/25 hover:bg-emerald-500/[0.10] hover:border-emerald-500/40",
  deleted:
    "bg-destructive/[0.06] border-destructive/25 hover:bg-destructive/[0.10] hover:border-destructive/40",
  resolved:
    "bg-muted/40 border-border hover:bg-muted/60 hover:border-border",
};

const FILTER_ORDER: ReadonlyArray<"all" | SessionStatus> = [
  "all",
  "ready",
  "ready-to-post",
  "drafting",
  "in-progress",
  "posted",
  "deleted",
  "resolved",
];

const FILTER_IDS = new Set<"all" | SessionStatus>(FILTER_ORDER);

// exported for tests
export function parseFilterParam(value: string | null): "all" | SessionStatus {
  return value && FILTER_IDS.has(value as "all" | SessionStatus)
    ? (value as "all" | SessionStatus)
    : "all";
}

export function DraftSessionsList(props: { platform?: FeedPlatform } = {}) {
  const params = useParams<{ workspaceId: string; platform: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const team = useFeedWorkspace();
  const t = useT().feedPage;
  const td = t.draftSessions;
  // Platform comes from the prop when hosted by the workspace-level
  // `/feed/drafts` page (platform chips), else from the legacy per-platform
  // route segment (docs/plans/feed-create-split.md D8).
  const platform = (props.platform ?? params.platform) as FeedPlatform;
  const profile = team.profiles.find((p) => p.platform === platform);
  // Create split (D7/D8): drafting needs no connection. The acting
  // assistant is the connected profile's when one exists, else the
  // workspace's first distribution assistant (the brand voice).
  const assistantId = profile?.assistantId ?? team.assistants[0]?.id ?? null;
  // Reply drafting needs the platform API (inbound target resolution +
  // publish) — hidden on create-only targets (instagram/xhs).
  const replyEnabled = isConnectableFeedPlatform(platform);
  const canDraft = team.canDraft;
  const platformLabel = t.platformLabels[platform];
  const isAdmin = team.role === "admin" || team.role === "owner";
  const meId = team.me.id;
  const { chooseAsync, dialog: choiceDialog } = useChoiceDialog();
  const { pickAccount, dialog: accountDialog } = useAccountPicker();

  const [sessions, setSessions] = useState<FeedDraftSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // `composing` covers all three create flows. The reply flow uses a single
  // input element that *is* the button (placeholder doubles as the label,
  // swapping to "Paste URL" on focus) — no expand/collapse toggle.
  const [composing, setComposing] = useState<null | "post" | "reply" | "link">(
    null,
  );
  const [replyUrl, setReplyUrl] = useState("");
  const [replyFocused, setReplyFocused] = useState(false);
  // Draft-from-link (feed-create-split.md D13) — same input-as-button
  // pattern as the reply URL box, available on every target platform.
  const [linkUrl, setLinkUrl] = useState("");
  const [linkFocused, setLinkFocused] = useState(false);
  const [filter, setFilter] = useState<"all" | SessionStatus>(() =>
    parseFilterParam(searchParams.get("filter")),
  );

  // Activity-row deep links (e.g. /draft-sessions?filter=posted) flip the
  // chip when the URL changes mid-mount; without this, the user would
  // land on "All" with no indication of why the URL had a filter.
  useEffect(() => {
    setFilter(parseFilterParam(searchParams.get("filter")));
  }, [searchParams]);
  // Optimistically hide a card while its DELETE is in flight so the row
  // doesn't ghost on screen between the click and the next list refresh.
  const [discardingId, setDiscardingId] = useState<string | null>(null);

  // Per-status counts for the filter chip badges. Computed once per
  // sessions update — sessions are bounded to ~50 so the cost is trivial.
  const statusCounts = useMemo(() => {
    const counts: Record<SessionStatus, number> = {
      ready: 0,
      "ready-to-post": 0,
      drafting: 0,
      "in-progress": 0,
      posted: 0,
      deleted: 0,
      resolved: 0,
    };
    for (const s of sessions) counts[deriveStatus(s)] += 1;
    return counts;
  }, [sessions]);

  const visibleSessions = useMemo(
    () =>
      filter === "all"
        ? sessions
        : sessions.filter((s) => deriveStatus(s) === filter),
    [sessions, filter],
  );

  // Responsive column count for the row-major masonry below. Mirrors the
  // breakpoints the prior CSS Grid used (`lg:grid-cols-2 2xl:grid-cols-3`)
  // so the visual cadence is unchanged — only the within-column flush
  // stacking is new.
  const colCount = useColumnCount();

  // Round-robin distribute into columns so reading order stays row-major
  // (item 0 → col 0, item 1 → col 1, …, item N → col N%colCount). Each
  // column then stacks flush via plain flex, removing the empty-row
  // gutters the prior `items-start` Grid produced. Trade-off: cards in
  // the "same row" are no longer bottom-aligned — accepted because the
  // user explicitly preferred no gaps over row alignment.
  const columns = useMemo(() => {
    const cols: FeedDraftSessionSummary[][] = Array.from(
      { length: colCount },
      () => [],
    );
    visibleSessions.forEach((s, i) => cols[i % colCount].push(s));
    return cols;
  }, [visibleSessions, colCount]);

  const loadFailedCopy = td.loadFailed;
  const load = useCallback(async () => {
    if (!assistantId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchFeedDraftSessions(assistantId, platform);
      setSessions(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : loadFailedCopy);
    } finally {
      setLoading(false);
    }
  }, [assistantId, platform, loadFailedCopy]);

  useEffect(() => {
    void load();
  }, [load]);

  // Discard a single session from the list. Authorization mirrors the
  // backend: admin/owner OR original starter. The button is hidden for
  // anyone else, but the backend re-checks regardless.
  //
  // chooseAsync swallows action errors (resolves 'cancel'), so surface any
  // failure into local state from inside the action body.
  const discardSessionOnly = useCallback(
    async (s: FeedDraftSessionSummary) => {
      if (!assistantId) return;
      setDiscardingId(s.id);
      setError(null);
      try {
        const result = await deleteFeedDraftSession(assistantId, s.id);
        if (!result.ok) {
          const message = result.error ?? td.discardFailed;
          setError(message);
          throw new Error(message);
        }
        setSessions((prev) => prev.filter((row) => row.id !== s.id));
      } finally {
        setDiscardingId(null);
      }
    },
    [assistantId, td.discardFailed],
  );

  // Take down every live post this session produced, then discard the
  // session. We fetch the session's saved drafts here (lazily, only when
  // the operator picks this option) and delete each one whose status is
  // still `posted`. A delete that fails (already gone, rate-limited)
  // surfaces an error but doesn't block discarding the session.
  const deletePostedAndDiscard = useCallback(
    async (s: FeedDraftSessionSummary) => {
      if (!assistantId) return;
      setDiscardingId(s.id);
      setError(null);
      try {
        const drafts = await fetchFeedSavedDrafts(assistantId, s.id);
        if (drafts) {
          const mediaIds = drafts
            .filter((d) => d.status === "posted" && d.postedMediaId)
            .map((d) => d.postedMediaId as string);
          for (const mediaId of mediaIds) {
            const del = await deleteFeedPublishedPost(
              assistantId,
              mediaId,
            );
            if (!del.ok) {
              setError(del.error ?? format(td.couldntDeletePost, { mediaId }));
            }
          }
        }
        const result = await deleteFeedDraftSession(assistantId, s.id);
        if (!result.ok) {
          const message = result.error ?? td.discardFailed;
          setError(message);
          throw new Error(message);
        }
        setSessions((prev) => prev.filter((row) => row.id !== s.id));
      } finally {
        setDiscardingId(null);
      }
    },
    [assistantId, td.couldntDeletePost, td.discardFailed],
  );

  const discardSession = useCallback(
    async (s: FeedDraftSessionSummary) => {
      if (!assistantId) return;
      // Sessions with live posts get the three-way choice: discard the
      // chat only, or also take the posted content down on the platform.
      if (s.draftCounts.posted > 0) {
        await chooseAsync(
          {
            title: td.discardTitle,
            description:
              s.draftCounts.posted === 1
                ? td.discardPostedDescriptionOne
                : format(td.discardPostedDescription, {
                    count: s.draftCounts.posted,
                  }),
            confirmLabel: td.discardDeleteLabel,
            variant: "destructive",
            secondaryLabel: td.discardOnlyLabel,
          },
          () => deletePostedAndDiscard(s),
          () => discardSessionOnly(s),
        );
        return;
      }
      const ok = await confirmDialog({
        title: td.discardTitle,
        description: td.discardDescription,
        confirmLabel: td.discardConfirmLabel,
        variant: "destructive",
      });
      if (!ok) return;
      try {
        await discardSessionOnly(s);
      } catch {
        // Error already surfaced into local state by the action body.
      }
    },
    [assistantId, chooseAsync, deletePostedAndDiscard, discardSessionOnly, td],
  );

  // Create a draft session and navigate to its detail page. The seed
  // payload is the **explicit** intent the operator chose by clicking
  // "+ New post" vs "Reply to URL"; the backend persists it on
  // `sessions.seed_kind` (migration 107) and the detail page reads it
  // back on mount. URLs the operator pastes into the chat after
  // creation never re-classify the session — they accumulate in the
  // post-intent References stockpile instead. See
  // `docs/architecture/feed/draft-sessions.md` → "Session intent".
  // Connected accounts on a given platform. A workspace can hold several
  // (each is its own `kind='app'` assistant); the platform route segment
  // alone can't disambiguate them, so we resolve the exact account here.
  const accountsOnPlatform = useCallback(
    (p: FeedPlatform) => team.profiles.filter((pr) => pr.platform === p),
    [team.profiles],
  );

  // Resolve which account a draft is for. 0 → null (caller surfaces a
  // connect-account error); 1 → that account, no prompt; ≥2 → ask the
  // operator so a draft never silently lands on the wrong account.
  async function resolveAccount(
    targetPlatform: FeedPlatform,
    intent: "post" | "reply",
  ): Promise<{ assistantId: string } | null> {
    const accounts = accountsOnPlatform(targetPlatform);
    if (accounts.length === 0) {
      // No connected account on the target platform. Original posts still
      // draft via the brand assistant (they resolve through the manual
      // ready-to-post queue at approve time — feed-create-split.md D2);
      // replies need the platform API, so the caller surfaces its
      // no-account error.
      if (intent === "reply") return null;
      return assistantId ? { assistantId } : null;
    }
    if (accounts.length === 1) return accounts[0];
    const label = t.platformLabels[targetPlatform];
    return pickAccount({
      title: format(td.pickAccountTitle, { platform: label }),
      description:
        intent === "reply"
          ? format(td.pickAccountReplyDescription, { platform: label })
          : format(td.pickAccountPostDescription, { platform: label }),
      accounts,
    });
  }

  async function createSession(
    seed: FeedDraftSessionSeed | undefined,
    label: "post" | "reply" | "link",
    account: { assistantId: string },
    targetPlatform: FeedPlatform,
  ) {
    if (composing) return;
    setComposing(label);
    setError(null);
    try {
      const result = await createFeedDraftSession(account.assistantId, {
        platform: targetPlatform,
        ...(seed ? { seed } : {}),
      });
      if (!result.ok) {
        throw new Error(result.error ?? td.createFailed);
      }
      // Thread the owning account through as `?account=` so the detail
      // page targets the same assistant for every call (stream, save,
      // approve) instead of re-resolving the first profile of the platform.
      const base = feedPath(params.workspaceId, {
        platform: targetPlatform,
        segment: "draft-sessions",
      });
      router.push(`${base}/${result.session.id}?account=${account.assistantId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : td.createFailed);
      setComposing(null);
    }
  }

  async function startNewPost() {
    if (composing) return;
    const account = await resolveAccount(platform, "post");
    if (!account) return; // page already guards: assistantId is non-null here
    // Explicit `freeform` seed locks the session into post intent; pasted
    // URLs in chat will be References, not reply targets.
    void createSession({ kind: "freeform" }, "post", account, platform);
  }

  async function submitLinkUrl() {
    if (composing) return;
    const trimmed = linkUrl.trim();
    if (!trimmed) {
      setError(td.linkUrlRequired);
      return;
    }
    // Any http(s) URL is a valid draft source (feed-create-split.md D13) —
    // platform post links become reference tiles, everything else is source
    // material the assistant reads before drafting. Mirrors the server-side
    // `parseSeed` validation so a junk paste fails here, not with a 400.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      setError(td.linkUrlInvalid);
      return;
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      setError(td.linkUrlInvalid);
      return;
    }
    const account = await resolveAccount(platform, "post");
    if (!account) return;
    void createSession(
      { kind: "freeform", link: trimmed.slice(0, 2048) },
      "link",
      account,
      platform,
    );
  }

  async function submitReplyUrl() {
    if (composing) return;
    const trimmed = replyUrl.trim();
    if (!trimmed) {
      setError(td.replyUrlRequired);
      return;
    }
    // Parse the URL into a structured candidate so the session is born
    // with an explicit `freeform-reply` seed — the detail page renders
    // the parent post via the platform embed and the approve handler
    // routes to `replyToPost`. No chat-message round-trip; no chance of
    // the URL being re-interpreted as a reference.
    const parsed = parseReplyUrl(trimmed);
    if (!parsed) {
      setError(td.replyUrlInvalid);
      return;
    }
    // The reply target's platform is authoritative — a pasted x.com URL
    // must reply via an X account even on the Threads tab. Pick the account
    // on the *target* platform, not the current tab.
    const targetPlatform = parsed.platform;
    const account = await resolveAccount(targetPlatform, "reply");
    if (!account) {
      setError(
        targetPlatform === "threads"
          ? td.replyNoAccountThreads
          : td.replyNoAccountX,
      );
      return;
    }
    const seed: FeedDraftSessionSeed = {
      kind: "freeform-reply",
      candidate: {
        platform: parsed.platform,
        externalId: parsed.externalId,
        authorHandle: parsed.handle,
        // Empty body — Threads/X both block scrapers, the embed renders
        // the post on the detail page. The backend accepts an empty
        // `text` for `freeform-reply` only.
        text: "",
        permalink: parsed.permalink,
      },
    };
    void createSession(seed, "reply", account, targetPlatform);
  }

  // Drafting no longer needs a connected platform (feed-create-split.md
  // D7/D8) — only a brand voice. With neither a profile nor a distribution
  // assistant, point at the feed home's create-brand zero state.
  if (!assistantId) {
    return (
      <div className="px-4 md:px-6 py-6 max-w-2xl space-y-4">
        <h1 className="text-[15px] font-semibold">
          {td.noBrandTitle}
        </h1>
        <p className="text-sm text-muted-foreground">
          {td.noBrandBody}
        </p>
        <Link
          href={feedPath(params.workspaceId)}
          className="inline-flex items-center justify-center rounded-lg bg-primary px-3 h-8 text-[12.5px] font-medium text-primary-foreground hover:bg-primary/90"
        >
          {td.noBrandCta}
        </Link>
      </div>
    );
  }

  return (
    <div className="px-4 md:px-6 py-5 max-w-7xl mx-auto space-y-5">
      {choiceDialog}
      {accountDialog}
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div className="space-y-1.5">
          <h1 className="text-[15px] font-semibold">
            {format(td.heading, { platform: platformLabel })}
          </h1>
          <p className="text-xs text-muted-foreground">
            {td.subtitle}
          </p>
        </div>
        {canDraft ? (
          // Vertical stack: "New reply" on top is an *input that doubles as a
          // button*. Empty + unfocused → reads "New reply" in foreground
          // weight (button-like). Focus → placeholder switches to "Paste URL"
          // and the chrome shifts to ring-on-primary (input-like). The user
          // never sees an explicit toggle — Enter submits, Esc cancels.
          //
          // "New post" sits below at the same width so the stack reads as a
          // pair. All transitions go through `duration-200 ease-out` for a
          // single, consistent feel.
          <ReplyAndPostStack
            composing={composing}
            replyEnabled={replyEnabled}
            replyUrl={replyUrl}
            replyFocused={replyFocused}
            platform={platform}
            linkUrl={linkUrl}
            linkFocused={linkFocused}
            onReplyChange={setReplyUrl}
            onReplyFocus={() => setReplyFocused(true)}
            onReplyBlur={() => setReplyFocused(false)}
            onReplySubmit={submitReplyUrl}
            onReplyCancel={() => {
              setReplyUrl("");
              setReplyFocused(false);
            }}
            onLinkChange={setLinkUrl}
            onLinkFocus={() => setLinkFocused(true)}
            onLinkBlur={() => setLinkFocused(false)}
            onLinkSubmit={submitLinkUrl}
            onLinkCancel={() => {
              setLinkUrl("");
              setLinkFocused(false);
            }}
            onNewPost={startNewPost}
          />
        ) : null}
      </header>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {!loading && sessions.length > 0 ? (
        <div
          role="tablist"
          aria-label={td.filterAria}
          className="flex flex-wrap items-center gap-1.5"
        >
          {FILTER_ORDER.map((id) => {
            const count = id === "all" ? sessions.length : statusCounts[id];
            const active = filter === id;
            const label = id === "all" ? td.filterAll : statusLabel(td, id);
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(id)}
                className={
                  "inline-flex items-center gap-1.5 rounded-full px-3 h-7 text-xs font-medium transition-colors " +
                  (active
                    ? "bg-primary text-primary-foreground"
                    : "bg-card border border-border text-muted-foreground hover:text-foreground hover:bg-accent")
                }
              >
                {label}
                <span
                  className={
                    "tabular-nums " +
                    (active ? "opacity-90" : "opacity-60")
                  }
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {loading ? (
        <ul className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <li key={i} className="rounded-xl border border-border bg-card p-4 animate-pulse space-y-2">
              <div className="h-4 w-1/3 bg-muted rounded" />
              <div className="h-3 w-4/5 bg-muted rounded" />
            </li>
          ))}
        </ul>
      ) : sessions.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center space-y-3">
          <p className="text-sm font-medium">{td.emptyTitle}</p>
          <p className="text-xs text-muted-foreground max-w-sm mx-auto">
            {canDraft ? td.emptyBodyCanDraft : td.emptyBodyNoDraft}
          </p>
          {canDraft ? (
            <div className="flex justify-center pt-1">
              <ReplyAndPostStack
                composing={composing}
                replyEnabled={replyEnabled}
                replyUrl={replyUrl}
                replyFocused={replyFocused}
                platform={platform}
                linkUrl={linkUrl}
                linkFocused={linkFocused}
                onReplyChange={setReplyUrl}
                onReplyFocus={() => setReplyFocused(true)}
                onReplyBlur={() => setReplyFocused(false)}
                onReplySubmit={submitReplyUrl}
                onReplyCancel={() => {
                  setReplyUrl("");
                  setReplyFocused(false);
                }}
                onLinkChange={setLinkUrl}
                onLinkFocus={() => setLinkFocused(true)}
                onLinkBlur={() => setLinkFocused(false)}
                onLinkSubmit={submitLinkUrl}
                onLinkCancel={() => {
                  setLinkUrl("");
                  setLinkFocused(false);
                }}
                onNewPost={startNewPost}
              />
            </div>
          ) : null}
        </div>
      ) : visibleSessions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center space-y-1.5 animate-fade-in">
          <p className="text-sm font-medium">{td.filterEmptyTitle}</p>
          <p className="text-xs text-muted-foreground">
            {td.filterEmptyBefore}{" "}
            <button
              type="button"
              onClick={() => setFilter("all")}
              className="text-primary hover:underline transition-colors"
            >
              {td.filterAll}
            </button>
            {td.filterEmptyAfter}
          </p>
        </div>
      ) : (
        <div
          // `key={filter}` re-mounts the list when the filter changes so
          // `.animate-stagger` re-fires the per-card rise-in. Without
          // this, refiltering snaps the cards into their new positions.
          key={filter}
          // Row-major masonry: items are round-robin distributed into
          // `columns` (item 0 → col 0, item 1 → col 1, …) so reading
          // top-to-bottom across columns yields chronological order.
          // Each column is a plain flex stack so cards sit flush —
          // removing the empty-row gutters the prior CSS Grid produced
          // when card heights varied (parent-post embeds run 200–800px).
          className="flex gap-3 items-start animate-stagger"
        >
          {columns.map((col, ci) => (
            <ul key={ci} className="flex-1 min-w-0 flex flex-col gap-3">
              {col.map((s) => {
            const status = deriveStatus(s);
            const kind = deriveCardKind(s);
            // Discard is admin-or-creator. Mirrors the backend gate so
            // members never see an action they'd be 403'd on.
            const canDiscard = isAdmin || s.startedBy.id === meId;
            const isDiscarding = discardingId === s.id;
            return (
              <li
                key={s.id}
                className={
                  "relative group transition-opacity " +
                  (isDiscarding ? "opacity-50 pointer-events-none" : "")
                }
              >
                <Link
                  href={`${feedPath(params.workspaceId, { platform, segment: "draft-sessions" })}/${s.id}`}
                  className={
                    "block h-full rounded-xl border p-3 space-y-2.5 shadow-sm hover:shadow-md transition-colors " +
                    STATUS_CARD_CHROME[status]
                  }
                >
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium text-foreground truncate">{s.title}</span>
                      <KindBadge kind={kind} />
                    </div>
                    <span className="shrink-0">{timeAgo(t.home, new Date(s.lastActiveAt).getTime())}</span>
                  </div>
                  <SessionPreviewTile
                    session={s}
                    assistantId={assistantId}
                    teamHandle={profile?.platformHandle ?? ""}
                    teamAvatarUrl={profile?.profilePictureUrl ?? null}
                  />
                  <div className="flex items-center justify-between gap-2 pt-0.5">
                    <span className="text-[11px] text-muted-foreground/80 truncate">
                      {format(td.startedBy, {
                        name: s.startedBy.name ?? td.unknownUser,
                      })}
                    </span>
                    <span
                      className={
                        "inline-flex items-center gap-1 rounded-full px-2 h-5 text-[10px] font-semibold uppercase tracking-wide shrink-0 " +
                        STATUS_BADGE_CLASS[status]
                      }
                    >
                      {statusLabel(td, status)}
                      {s.draftCounts.pending > 0 ? (
                        <span className="tabular-nums">· {s.draftCounts.pending}</span>
                      ) : null}
                    </span>
                  </div>
                </Link>
                {canDiscard ? (
                  <button
                    type="button"
                    title={td.discardAction}
                    aria-label={td.discardAction}
                    onClick={(e) => {
                      // Sibling-of-Link, not a descendant — preventDefault
                      // is belt-and-braces in case event ordering changes.
                      e.preventDefault();
                      e.stopPropagation();
                      void discardSession(s);
                    }}
                    disabled={isDiscarding}
                    className="absolute top-2 right-2 h-6 w-6 inline-flex items-center justify-center rounded-md bg-card/90 backdrop-blur-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity disabled:opacity-50"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                ) : null}
              </li>
            );
          })}
            </ul>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Tracks the active masonry column count via `matchMedia`, mirroring the
 * Tailwind `lg` (1024px) and `2xl` (1536px) breakpoints the prior CSS
 * Grid used. Initialized from `window` on mount so the first paint after
 * hydration already has the right column count — initial SSR render
 * uses `1`, but this page is client-fetched so the SSR markup is the
 * loading skeleton, not the cards.
 */
function useColumnCount(): number {
  const [count, setCount] = useState(1);
  useEffect(() => {
    const mqLg = window.matchMedia("(min-width: 1024px)");
    const mq2xl = window.matchMedia("(min-width: 1536px)");
    const update = () => {
      if (mq2xl.matches) setCount(3);
      else if (mqLg.matches) setCount(2);
      else setCount(1);
    };
    update();
    mqLg.addEventListener("change", update);
    mq2xl.addEventListener("change", update);
    return () => {
      mqLg.removeEventListener("change", update);
      mq2xl.removeEventListener("change", update);
    };
  }, []);
  return count;
}

function timeAgo(t: FeedPageDict["home"], ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return t.timeJustNow;
  const min = Math.floor(diff / 60_000);
  if (min < 60) return format(t.timeMinutesAgo, { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return format(t.timeHoursAgo, { count: hr });
  return format(t.timeDaysAgo, { count: Math.floor(hr / 24) });
}

/**
 * Vertical "New reply" + "New post" pair. Refined to read as professional
 * tooling rather than a marketing CTA: 8px-radius corners, h-9 (36px) — the
 * SaaS standard for a primary header control — and a 13px label so the
 * stack carries weight without shouting.
 *
 * The reply control is an `<input>` that reads as a button when empty +
 * unfocused (label-weight placeholder "New reply" with a leading caret).
 * Focus swaps the placeholder to "Paste URL", shifts the border to a
 * subtle primary tint, and reveals a flat submit caret on the right. No
 * filled circle, no glow ring — the prior chunky teal pill made the
 * affordance feel like a child's slideshow control.
 *
 * Single transition rule: `duration-150 ease-out`. Slightly faster than
 * the prior 200ms so the UI feels responsive rather than gummy, and one
 * shared timing across hover/focus/disabled states so nothing judders.
 */
function ReplyAndPostStack(props: {
  composing: null | "post" | "reply" | "link";
  replyUrl: string;
  replyFocused: boolean;
  platform: FeedPlatform;
  /** False on platforms without inbound integration (instagram/xhs) —
   *  the reply-URL input is hidden; only the link input + "New post" render. */
  replyEnabled: boolean;
  linkUrl: string;
  linkFocused: boolean;
  onReplyChange: (v: string) => void;
  onReplyFocus: () => void;
  onReplyBlur: () => void;
  onReplySubmit: () => void;
  onReplyCancel: () => void;
  onLinkChange: (v: string) => void;
  onLinkFocus: () => void;
  onLinkBlur: () => void;
  onLinkSubmit: () => void;
  onLinkCancel: () => void;
  onNewPost: () => void;
}) {
  const {
    composing,
    replyUrl,
    replyFocused,
    platform,
    replyEnabled,
    linkUrl,
    linkFocused,
    onReplyChange,
    onReplyFocus,
    onReplyBlur,
    onReplySubmit,
    onReplyCancel,
    onLinkChange,
    onLinkFocus,
    onLinkBlur,
    onLinkSubmit,
    onLinkCancel,
    onNewPost,
  } = props;
  const td = useT().feedPage.draftSessions;
  const disabled = composing !== null;
  const replyActive = replyFocused || replyUrl.length > 0;
  const linkActive = linkFocused || linkUrl.length > 0;
  const focusedPlaceholder =
    platform === "threads" ? td.pasteThreadsUrl : td.pasteXUrl;
  return (
    <div className="flex flex-col items-stretch gap-1.5 w-60">
      {replyEnabled ? (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onReplySubmit();
        }}
        className="relative"
      >
        <input
          type="url"
          value={replyUrl}
          onChange={(e) => onReplyChange(e.target.value)}
          onFocus={onReplyFocus}
          onBlur={onReplyBlur}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.currentTarget.blur();
              onReplyCancel();
            }
          }}
          placeholder={replyActive ? focusedPlaceholder : td.newReply}
          disabled={disabled}
          aria-label={td.replyAria}
          className={
            "w-full h-9 rounded-lg text-[13px] border bg-card transition-all duration-150 ease-out focus:outline-none disabled:opacity-50 " +
            (replyActive
              ? // Active — left-align for URL readability, room on the
                // right for the submit caret. Border tint alone is the
                // focus cue; no ring at this scale.
                "text-left pl-3 pr-8 border-primary/50 shadow-sm text-foreground font-normal placeholder:text-muted-foreground placeholder:font-normal"
              : // Resting — secondary-button styling. `border-border`
                // alone disappeared against the light page background;
                // `border-foreground/15` + `shadow-sm` give it presence
                // without competing with the primary "New post" below.
                // Centered placeholder matches the post button label so
                // the pair reads as one unit.
                "text-center px-3 border-foreground/15 shadow-sm text-foreground hover:border-foreground/30 hover:bg-accent/50 hover:shadow cursor-text placeholder:text-foreground placeholder:font-medium")
          }
        />
        {/* Flat submit caret — visible only while active. No circle, no
            fill: at this scale the icon alone is the affordance, and the
            input's own border supplies the visual edge. */}
        <button
          type="submit"
          disabled={disabled || !replyUrl.trim()}
          aria-label={composing === "reply" ? td.creating : td.startReply}
          className={
            "absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all duration-150 ease-out disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground " +
            (replyActive
              ? "opacity-100 translate-x-0 pointer-events-auto"
              : "opacity-0 translate-x-1 pointer-events-none")
          }
        >
          {composing === "reply" ? (
            <SpinnerIcon />
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          )}
        </button>
      </form>
      ) : null}

      {/* Draft-from-link (D13) — same input-as-button pattern as the reply
          box, on every target platform. Any http(s) URL is accepted. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onLinkSubmit();
        }}
        className="relative"
      >
        <input
          type="url"
          value={linkUrl}
          onChange={(e) => onLinkChange(e.target.value)}
          onFocus={onLinkFocus}
          onBlur={onLinkBlur}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.currentTarget.blur();
              onLinkCancel();
            }
          }}
          placeholder={linkActive ? td.pasteLinkUrl : td.newFromLink}
          disabled={disabled}
          aria-label={td.linkAria}
          className={
            "w-full h-9 rounded-lg text-[13px] border bg-card transition-all duration-150 ease-out focus:outline-none disabled:opacity-50 " +
            (linkActive
              ? "text-left pl-3 pr-8 border-primary/50 shadow-sm text-foreground font-normal placeholder:text-muted-foreground placeholder:font-normal"
              : "text-center px-3 border-foreground/15 shadow-sm text-foreground hover:border-foreground/30 hover:bg-accent/50 hover:shadow cursor-text placeholder:text-foreground placeholder:font-medium")
          }
        />
        <button
          type="submit"
          disabled={disabled || !linkUrl.trim()}
          aria-label={composing === "link" ? td.creating : td.startFromLink}
          className={
            "absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all duration-150 ease-out disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground " +
            (linkActive
              ? "opacity-100 translate-x-0 pointer-events-auto"
              : "opacity-0 translate-x-1 pointer-events-none")
          }
        >
          {composing === "link" ? (
            <SpinnerIcon />
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          )}
        </button>
      </form>

      <button
        type="button"
        onClick={onNewPost}
        disabled={disabled}
        className="inline-flex items-center justify-center h-9 rounded-lg bg-primary text-primary-foreground text-[13px] font-medium hover:bg-primary/90 active:bg-primary/85 disabled:opacity-50 transition-all duration-150 ease-out"
      >
        {composing === "post" ? td.creating : td.newPost}
      </button>
    </div>
  );
}

function SpinnerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden className="animate-spin">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={2} strokeOpacity={0.25} />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Card kind — drives both the preview body layout and the small badge shown
 * in the card header so reply cards are distinguishable from original posts
 * at a glance.
 *
 *   reply     — session has a parsed `replyTarget` (the seed message named a
 *               post being replied to). The preview stacks the parent post
 *               on top and our reply draft underneath.
 *   original  — no reply target but the assistant has produced at least one
 *               draft option. The preview shows the draft alone.
 *   pending   — neither yet; show the chat preview text or the empty-state.
 */
type CardKind = "reply" | "original" | "pending";

/**
 * Body text the card should display for the team's draft. A saved draft
 * (anything in the approval queue, including already-posted) wins over
 * the model's latest in-chat `proposeDrafts` candidate so the reviewer
 * sees what the team actually committed to. The chat candidate may have
 * iterated past the saved version — and for posted rows we want the
 * actually-published body, not whatever the model later proposed.
 */
// exported for tests
export function displayDraftText(
  session: Pick<FeedDraftSessionSummary, "selectedDraft" | "draftText">,
): string | null {
  return session.selectedDraft?.text ?? session.draftText;
}

// exported for tests
export function deriveCardKind(
  session: Pick<
    FeedDraftSessionSummary,
    "replyTarget" | "selectedDraft" | "draftText"
  >,
): CardKind {
  if (session.replyTarget) return "reply";
  if (displayDraftText(session)) return "original";
  return "pending";
}

/**
 * Per-card preview body. Three render modes, in priority order:
 *
 *   1. **Reply** — the session's seed named a post to reply to. Render a
 *      compact `QuotedPostPreview` of the parent post, a thin `ReplyConnector`
 *      chip, then the team's draft as a `PostDraftPreview` underneath. Both
 *      tiles together give the reviewer the *what we're responding to* and
 *      *what we're sending* in one glance — the draft alone left them
 *      guessing what the post was actually about.
 *   2. **Original** — no reply target, but `proposeDrafts` has produced an
 *      option. Render the draft alone with an "Original" badge.
 *   3. **Pending** — no reply target, no draft yet. Fall back to the existing
 *      chat preview text (assistant rationale or last turn) or the
 *      empty-state hint.
 *
 * Per-card parent posts render via `ExternalPostCard` (server-cached
 * post data, no iframe) so we don't burst-mount Meta's embed iframes
 * across a 16-card grid and trip the per-IP rate limit. The detail
 * page (one card at a time, no burst risk) keeps using `NativeEmbed`
 * for full embed fidelity.
 */
function SessionPreviewTile({
  session,
  assistantId,
  teamHandle,
  teamAvatarUrl,
}: {
  session: FeedDraftSessionSummary;
  /** Used by `ExternalPostCard` to scope its `/external-post` fetch
   *  to the right Threads/X-connected account (the resolver chain
   *  needs that account's access token). */
  assistantId: string;
  teamHandle: string;
  teamAvatarUrl: string | null;
}) {
  const td = useT().feedPage;
  const kind = deriveCardKind(session);

  if (kind === "reply") {
    const target = session.replyTarget!;
    return (
      <div>
        {target.permalink ? (
          // Server-rendered post card. Replaces the prior `NativeEmbed`
          // iframe path: Meta's embed CDN is per-IP rate-limited and a
          // 16-card grid burst-loaded enough iframes to trip it,
          // producing stale "Sorry, couldn't load" tiles that no
          // amount of in-page reload could fix (see git history of
          // `native-post-embed.tsx`). The new path fetches structured
          // post data from `/api/distribution/:id/external-post`,
          // which caches Meta's response server-side, so the user's
          // browser only ever talks to our domain. We fall back to
          // the seed `replyTarget` text/handle so the card has
          // believable content while the fetch is in flight.
          <ExternalPostCard
            assistantId={assistantId}
            platform={session.platform}
            permalink={target.permalink}
            fallbackAuthorHandle={target.authorHandle}
            fallbackText={target.text || null}
          />
        ) : (
          // Older inspiration-seeded sessions whose seed didn't carry a
          // permalink. We still have the quoted post body — render it as
          // a compact text tile.
          <QuotedPostPreview
            platform={session.platform}
            authorHandle={target.authorHandle}
            text={target.text}
            permalink={null}
          />
        )}
        <ReplyConnector />
        {displayDraftText(session) ? (
          <PostDraftPreview
            platform={session.platform}
            authorHandle={teamHandle}
            avatarUrl={teamAvatarUrl}
            text={displayDraftText(session)!}
            compact
          />
        ) : (
          // Reply session that hasn't produced a draft yet — close out the
          // stacked thread with a muted placeholder. No border or top
          // divider: the `ReplyConnector` above already provides visual
          // separation and the outer Link card frames the whole stack.
          <div className="px-1 pt-0.5 text-[12px] text-muted-foreground italic">
            {td.inbox.noReplyDrafted}
            {session.preview ? (
              <span className="block mt-1 not-italic text-foreground/70 line-clamp-2">
                {session.preview}
              </span>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  if (kind === "original") {
    return (
      <PostDraftPreview
        platform={session.platform}
        authorHandle={teamHandle}
        avatarUrl={teamAvatarUrl}
        text={displayDraftText(session)!}
      />
    );
  }

  // Pending — no parent, no draft.
  if (session.preview) {
    return (
      <p className="text-sm text-muted-foreground line-clamp-2 leading-relaxed">
        {session.preview}
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground italic">
      {td.draftSessions.noMessages}
    </p>
  );
}

/**
 * Header badge differentiating reply / original / pending sessions at a
 * glance. Rendered next to the timestamp in the card header so the
 * scanning eye picks up the kind even before reading the preview body.
 */
const KIND_BADGE_CLASS: Record<Exclude<CardKind, "pending">, string> = {
  reply: "bg-primary/10 text-primary ring-1 ring-primary/25",
  original: "bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/30",
};

function KindBadge({ kind }: { kind: CardKind }) {
  const t = useT().feedPage;
  if (kind === "pending") return null;
  const label = kind === "reply" ? t.inbox.kindReply : t.inbox.kindOriginal;
  return (
    <span
      className={
        "inline-flex items-center rounded-full px-2 h-5 text-[10px] font-semibold uppercase tracking-wide " +
        KIND_BADGE_CLASS[kind]
      }
    >
      {label}
    </span>
  );
}
