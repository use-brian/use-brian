"use client";

/**
 * Server-rendered post-card replacement for `NativeEmbed` — ported
 * faithfully from `apps/feed-web/src/components/external-post-card.tsx`
 * (docs/plans/feed-web-consolidation.md §7.2). Full component API kept:
 * draft-sessions and inspiration (later phases) render the same card.
 *
 * Port deltas (disposition rules §6): the fetch rides the feed SDK
 * (`fetchFeedExternalPost`, which throws the server's `error` reason so the
 * catch below reproduces feed-web's degrade states exactly); the local
 * `Platform` union becomes `FeedPlatform`; all copy via
 * `useT().feedPage.postEmbed`. No logic or markup changes.
 *
 * Fetches structured post data from `/api/distribution/:id/external-post`
 * (which scrapes Meta's `?_fb_noscript=1` server-rendered fallback
 * page once and caches it system-wide) and renders a Threads-styled
 * card — no iframe, no `embed.js`, no per-IP CDN rate limit risk.
 *
 * The card visually mirrors Threads' own embed layout (avatar →
 * handle → time-ago, body, engagement-counter row, "View on Threads"
 * pill in the footer) so the visual regression vs the iframe is
 * minimal.
 *
 * Three render states:
 *   - **Full data** — author + text + (optional) media + counters.
 *     The card paints the full Threads-styled layout.
 *   - **Loading** — pre-paints the card with whatever seed data
 *     exists (`fallbackAuthorHandle` / `fallbackText` from
 *     `replyTarget`) so the operator sees a believable card while
 *     the fetch is in flight, with a faint shimmer over the fields
 *     we don't have yet.
 *   - **Failed** — same shell as loading but with a small footer
 *     note explaining we couldn't refresh; "View on Threads ↗" link
 *     stays clickable so the reviewer always has a path to the
 *     source post.
 *
 * [COMP:app-web/feed-post-embed]
 */

import { useEffect, useMemo, useState } from "react";
import {
  fetchFeedExternalPost,
  type FeedExternalPost,
  type FeedExternalPostSpoiler,
} from "@/lib/api/feed";
import type { FeedPlatform } from "@/lib/feed-nav";
import { EmbedSkeleton } from "@/components/feed/native-post-embed";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

type PostEmbedDict = ReturnType<typeof useT>["feedPage"]["postEmbed"];

type FetchState =
  | { kind: "loading" }
  | { kind: "ok"; data: FeedExternalPost }
  | { kind: "error"; reason: string };

export function ExternalPostCard({
  assistantId,
  platform,
  permalink,
  fallbackAuthorHandle,
  fallbackText,
}: {
  assistantId: string;
  platform: FeedPlatform;
  permalink: string;
  /** Seed-data hints from the draft session's parsed first message
   *  (`replyTarget.authorHandle` / `.text`). Painted immediately so
   *  the operator never sees an empty shimmer. */
  fallbackAuthorHandle?: string | null;
  fallbackText?: string | null;
}) {
  const [state, setState] = useState<FetchState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      try {
        const data = await fetchFeedExternalPost(assistantId, {
          permalink,
          platform,
        });
        if (cancelled) return;
        setState({ kind: "ok", data });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          reason: err instanceof Error ? err.message : "fetch_failed",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assistantId, platform, permalink]);

  if (state.kind === "loading") {
    if (fallbackText || fallbackAuthorHandle) {
      return (
        <PostCardShell
          platform={platform}
          permalink={permalink}
          authorHandle={fallbackAuthorHandle ?? null}
          authorProfilePictureUrl={null}
          text={fallbackText ?? null}
          spoilerRanges={null}
          mediaUrl={null}
          mediaType={null}
          timestamp={null}
          likes={null}
          replies={null}
          reposts={null}
          quotes={null}
          loading
        />
      );
    }
    return (
      <div className="relative min-h-44">
        <EmbedSkeleton />
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <PostCardShell
        platform={platform}
        permalink={permalink}
        authorHandle={fallbackAuthorHandle ?? null}
        authorProfilePictureUrl={null}
        text={fallbackText ?? null}
        spoilerRanges={null}
        mediaUrl={null}
        mediaType={null}
        timestamp={null}
        likes={null}
        replies={null}
        reposts={null}
        quotes={null}
        errorReason={state.reason}
      />
    );
  }

  return (
    <PostCardShell
      platform={platform}
      permalink={permalink}
      authorHandle={state.data.authorHandle}
      authorProfilePictureUrl={state.data.authorProfilePictureUrl}
      text={state.data.text}
      spoilerRanges={state.data.spoilerRanges}
      mediaUrl={state.data.mediaUrl}
      mediaType={state.data.mediaType}
      timestamp={state.data.timestamp}
      likes={state.data.likes}
      replies={state.data.replies}
      reposts={state.data.reposts}
      quotes={state.data.quotes}
    />
  );
}

function PostCardShell({
  platform,
  permalink,
  authorHandle,
  authorProfilePictureUrl,
  text,
  spoilerRanges,
  mediaUrl,
  mediaType,
  timestamp,
  likes,
  replies,
  reposts,
  quotes,
  loading,
  errorReason,
}: {
  platform: FeedPlatform;
  permalink: string;
  authorHandle: string | null;
  authorProfilePictureUrl: string | null;
  text: string | null;
  spoilerRanges: FeedExternalPostSpoiler[] | null;
  mediaUrl: string | null;
  mediaType: FeedExternalPost["mediaType"];
  timestamp: string | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  quotes: number | null;
  loading?: boolean;
  errorReason?: string;
}) {
  const feedT = useT().feedPage;
  const t = feedT.postEmbed;
  const platformLabel = feedT.platformLabels[platform];
  const handle = authorHandle ?? t.unknownHandle;
  // Show the engagement row only when we actually have at least one
  // counter back. During loading/error fallbacks we have nothing, so
  // the row would otherwise paint as empty whitespace.
  const hasEngagement =
    likes !== null || replies !== null || reposts !== null || quotes !== null;
  return (
    <article className="rounded-xl border border-border/60 bg-card/60 overflow-hidden">
      <header className="flex items-center gap-2.5 px-4 pt-3">
        <Avatar
          url={authorProfilePictureUrl}
          handle={handle}
          platform={platform}
        />
        <div className="min-w-0 flex-1">
          <span className="text-sm font-semibold truncate block text-foreground">
            {handle}
          </span>
        </div>
        {timestamp ? (
          <time
            dateTime={timestamp}
            title={new Date(timestamp).toLocaleString()}
            className="shrink-0 text-[12px] text-muted-foreground tabular-nums"
          >
            {formatRelativeTime(t, timestamp)}
          </time>
        ) : null}
      </header>
      <div className="px-4 pt-2 pb-3 space-y-2">
        {text ? (
          <p className="text-[14px] leading-[1.5] whitespace-pre-wrap break-words line-clamp-6 text-foreground/90">
            <SpoilerAwareText text={text} spoilers={spoilerRanges} />
          </p>
        ) : loading ? (
          <div className="space-y-1.5">
            <div className="skeleton h-3 w-4/5 rounded" />
            <div className="skeleton h-3 w-3/5 rounded" />
          </div>
        ) : (
          <p className="text-[12px] italic text-muted-foreground">
            {t.postBodyUnavailable}
          </p>
        )}
        {mediaUrl && (mediaType === "IMAGE" || mediaType === "CAROUSEL") ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mediaUrl}
            alt={format(t.mediaAlt, { handle })}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="block w-full max-h-72 object-cover rounded-md border border-border/40"
          />
        ) : null}
        {mediaUrl && mediaType === "VIDEO" ? (
          <video
            src={mediaUrl}
            controls
            preload="metadata"
            className="block w-full max-h-72 rounded-md border border-border/40 bg-black"
          />
        ) : null}
      </div>
      {hasEngagement || !loading ? (
        <div className="flex items-end justify-between gap-3 px-4 pb-3">
          {hasEngagement ? (
            <div className="flex items-center gap-3.5 text-[12.5px] text-muted-foreground">
              <Counter
                icon={<HeartIcon />}
                value={likes}
                ariaTemplate={t.likesAria}
              />
              <Counter
                icon={<CommentIcon />}
                value={replies}
                ariaTemplate={t.repliesAria}
              />
              <Counter
                icon={<RepostIcon />}
                value={reposts}
                ariaTemplate={t.repostsAria}
              />
              <Counter
                icon={<ShareIcon />}
                value={quotes}
                ariaTemplate={t.sharesAria}
              />
            </div>
          ) : (
            <span aria-hidden />
          )}
          <a
            href={permalink}
            target="_blank"
            rel="noreferrer noopener"
            // Stop click bubbling so the parent draft-card link doesn't
            // also navigate when the user clicks the source link.
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 rounded-full bg-muted/60 hover:bg-muted px-3 h-7 text-[11.5px] font-medium text-foreground/80 hover:text-foreground transition-colors"
          >
            {format(t.viewOn, { platform: platformLabel })}
            <span aria-hidden>↗</span>
          </a>
        </div>
      ) : null}
      {errorReason ? (
        <div className="px-4 py-1.5 text-[11px] text-muted-foreground/80 border-t border-border/40">
          {format(t.couldntRefresh, { reason: errorReason })}
        </div>
      ) : null}
    </article>
  );
}

/**
 * Render `text` interleaving plain runs with `<SpoilerSegment>`
 * blurred-until-tap segments, matching the official Threads embed UX
 * for `text_entities[entity_type='SPOILER']` ranges. When
 * `spoilers` is null or empty we just emit the text as-is — no extra
 * span wrapping so the React tree stays flat for the no-spoiler
 * common case.
 *
 * Assumes spoilers are non-overlapping (which Threads guarantees) but
 * tolerates them coming in unsorted order by sorting first.
 */
function SpoilerAwareText({
  text,
  spoilers,
}: {
  text: string;
  spoilers: FeedExternalPostSpoiler[] | null;
}) {
  if (!spoilers || spoilers.length === 0) return <>{text}</>;
  // Defensive: sort and clamp ranges so a malformed payload can't
  // produce overlapping or out-of-bounds slices.
  const sorted = [...spoilers]
    .map((s) => ({
      offset: Math.max(0, Math.min(s.offset, text.length)),
      length: Math.max(0, Math.min(s.length, text.length - s.offset)),
    }))
    .filter((s) => s.length > 0)
    .sort((a, b) => a.offset - b.offset);
  const segments: Array<{ kind: "plain" | "spoiler"; text: string }> = [];
  let cursor = 0;
  for (const r of sorted) {
    if (r.offset > cursor) {
      segments.push({ kind: "plain", text: text.slice(cursor, r.offset) });
    }
    segments.push({
      kind: "spoiler",
      text: text.slice(r.offset, r.offset + r.length),
    });
    cursor = r.offset + r.length;
  }
  if (cursor < text.length) {
    segments.push({ kind: "plain", text: text.slice(cursor) });
  }
  return (
    <>
      {segments.map((s, i) =>
        s.kind === "spoiler" ? (
          <SpoilerSegment key={i}>{s.text}</SpoilerSegment>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Click-to-reveal blur. Mirrors the Threads UI: text stays
 * semantically present (so screen readers and selection-after-reveal
 * work) but the glyphs are scrambled by `filter: blur(4px)` until
 * the user taps. Splits the text into per-word (ASCII) /
 * per-character (CJK + punctuation) chunks each rendered as
 * `.spoiler-glyph` (`display: inline-block`) so the blur applies
 * cleanly to every glyph yet the spoiler still wraps at natural
 * word boundaries — whitespace is rendered as plain text between
 * chunks so the browser's line-breaker sees the boundaries.
 *
 * `stopPropagation` because the embed sits inside a `<Link>` card on
 * the drafts list — without it the tap would also navigate the
 * parent card. We render a `<span role="button">` rather than a real
 * `<button>` because `<button>` (a) enforces phrasing-content rules
 * that disallow nested interactive children, and (b) brings its own
 * `text-align`/font defaults that fight the inherited paragraph
 * styling — a span with `role="button"` + `tabIndex` keeps
 * accessibility while letting the chip behave like text.
 */
function SpoilerSegment({ children }: { children: React.ReactNode }) {
  const t = useT().feedPage.postEmbed;
  const [revealed, setRevealed] = useState(false);
  const text = typeof children === "string" ? children : String(children);
  const chunks = useMemo(() => splitForBlur(text), [text]);

  const reveal = (e: React.SyntheticEvent) => {
    if (revealed) return;
    e.preventDefault();
    e.stopPropagation();
    setRevealed(true);
  };

  return (
    <span
      role="button"
      tabIndex={revealed ? -1 : 0}
      title={revealed ? undefined : t.spoilerTitle}
      aria-label={revealed ? t.spoilerRevealedAria : t.spoilerHiddenAria}
      aria-pressed={revealed}
      data-revealed={revealed ? "true" : "false"}
      onClick={reveal}
      onKeyDown={(e) => {
        if (revealed) return;
        if (e.key === "Enter" || e.key === " ") reveal(e);
      }}
      className="spoiler"
    >
      {chunks.map((c, i) =>
        c.kind === "gap" ? (
          // Plain whitespace text node — keeps line-break opportunities
          // intact so a long blurred phrase wraps at word boundaries
          // instead of forcing horizontal overflow on the parent line.
          <span key={i}>{c.text}</span>
        ) : (
          <span key={i} className="spoiler-glyph">
            {c.text}
          </span>
        ),
      )}
    </span>
  );
}

/**
 * Split spoiler text into chunks the CSS `filter: blur` layer can
 * render as discrete inline-block boxes. ASCII letter/digit runs stay
 * grouped (one inline-block per word) so the blur bleeds across
 * letters smoothly; everything else — CJK ideographs, punctuation,
 * symbols — is split per Unicode code point so a long Chinese
 * spoiler can wrap mid-phrase. Whitespace runs are emitted as `gap`
 * tokens and rendered as plain text by the caller, preserving the
 * browser's natural line-break opportunities.
 */
function splitForBlur(
  text: string,
): Array<{ kind: "glyph" | "gap"; text: string }> {
  const tokens = text.match(/\s+|[A-Za-z0-9'’\-]+|./gu) ?? [];
  return tokens.map((t) =>
    /^\s+$/.test(t)
      ? { kind: "gap" as const, text: t }
      : { kind: "glyph" as const, text: t },
  );
}

function Avatar({
  url,
  handle,
  platform,
}: {
  url: string | null;
  handle: string;
  platform: FeedPlatform;
}) {
  const initial = handle.charAt(0).toUpperCase() || "?";
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={`@${handle}`}
        width={36}
        height={36}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="shrink-0 rounded-full object-cover bg-muted w-9 h-9"
      />
    );
  }
  const isX = platform === "twitter";
  return (
    <div
      className={`shrink-0 w-9 h-9 rounded-full ${
        isX ? "bg-foreground text-background" : "bg-muted text-foreground/70"
      } flex items-center justify-center text-sm font-semibold`}
      aria-hidden
    >
      {initial}
    </div>
  );
}

function Counter({
  icon,
  value,
  ariaTemplate,
}: {
  icon: React.ReactNode;
  value: number | null;
  /** i18n template with a `{count}` slot (e.g. `"{count} likes"`). */
  ariaTemplate: string;
}) {
  if (value === null) return null;
  return (
    <span
      className="inline-flex items-center gap-1 tabular-nums"
      aria-label={format(ariaTemplate, { count: value })}
    >
      <span aria-hidden className="text-muted-foreground/80">
        {icon}
      </span>
      {formatCount(value)}
    </span>
  );
}

/** "31527" → "31.5K", "1234567" → "1.2M". Matches the Threads /
 *  X embed look. */
function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

/** Compact relative time matching Threads' embed format ("19h", "3m",
 *  "2d"). Falls back to absolute date for posts older than a year. */
function formatRelativeTime(t: PostEmbedDict, iso: string): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return t.timeNow;
  const min = Math.floor(diff / 60_000);
  if (min < 60) return format(t.timeMinutes, { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return format(t.timeHours, { count: hr });
  const d = Math.floor(hr / 24);
  if (d < 7) return format(t.timeDays, { count: d });
  const w = Math.floor(d / 7);
  if (w < 5) return format(t.timeWeeks, { count: w });
  const mo = Math.floor(d / 30);
  if (mo < 12) return format(t.timeMonths, { count: mo });
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const ICON_PROPS = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor" as const,
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function HeartIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden>
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

function CommentIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function RepostIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden>
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}
