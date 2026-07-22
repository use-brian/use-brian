"use client";

/**
 * Native platform embed + CSS post-preview tiles — ported faithfully from
 * `apps/feed-web/src/components/native-post-embed.tsx`
 * (docs/plans/feed-web-consolidation.md §7.2). Shared by the inbox and, in
 * later phases, draft-sessions and inspiration — the full component API is
 * kept (`NativeEmbed`, `EmbedSkeleton`, `LazyMount`, `PostDraftPreview`,
 * `QuotedPostPreview`, `ReplyConnector`), not trimmed to inbox needs.
 *
 * Port deltas (disposition rules §6): the local `Platform` union becomes
 * `FeedPlatform` from `@/lib/feed-nav`; every user-visible string flows
 * through `useT().feedPage` (`postEmbed` + `platformLabels`). No logic or
 * markup changes.
 *
 * [COMP:app-web/feed-post-embed]
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { FeedPlatform } from "@/lib/feed-nav";
import { PlatformIcon } from "@/components/feed/platform-icon";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

/**
 * Native platform embed — uses Threads' `embed.js` or X's `widgets.js` to
 * replace a `<blockquote>` placeholder with the platform's iframe-based
 * embed. Used by the draft-sessions detail page (cardboard "Replying to"
 * tile) and the list page (per-card preview of the post being replied to).
 *
 * The blockquote is built imperatively inside a React-owned wrapper rather
 * than rendered as JSX. The embed scripts wrap/replace the blockquote with
 * their iframe when they process it; if React also owns that node, its
 * reconciliation on `permalink` change collides with the script's mutation
 * (orphan iframes, silent removeChild failures) and the new post never
 * renders. React owns the wrapper; we own everything inside it.
 *
 * Script-load is also guarded both ways: if the script is already loaded
 * we reprocess immediately; if it's still in flight (fast session
 * navigation, slow CDN, StrictMode double-effect) we attach a `load`
 * listener so reprocess runs as soon as it finishes.
 *
 * Loading UX:
 *   - The source blockquote is pulled out of flow with `position:
 *     absolute; opacity: 0` so its fallback `View on …` link doesn't
 *     flash for ~150ms before the script swaps it for the iframe.
 *   - The iframe is started at `opacity: 0` and faded in once it fires
 *     `load` *or* a `ResizeObserver` reports a non-zero height (Threads
 *     /X push the iframe height via postMessage *after* `load` in some
 *     code paths, and `load` can fire before our listener attaches if
 *     the iframe was cached).
 *   - A fluid shimmer skeleton overlays the wrapper until the iframe is
 *     ready, then fades out.
 *   - The wrapper carries a `min-height` *only* while loading so the
 *     card doesn't collapse before the iframe paints; once ready the
 *     min-height transitions back to `0` so a short post doesn't leave
 *     empty space below the iframe. The iframe itself is always in flow,
 *     so for tall posts the wrapper grows naturally to whatever height
 *     the embed reports — no max cap.
 */
/**
 * Outer wrapper that owns the reload-key + dormant state and renders
 * the hover-revealed reload button. The actual embed body
 * (`NativeEmbedBody`) is mounted only when `dormant === false`; setting
 * `dormant = true` for ~1 s during a reload is what actually moves the
 * needle on stale embeds.
 *
 * **Why a 1 s DOM-gap reload** (and not a synchronous remount):
 *
 * Cmd+R works to fix stale embeds because (a) the browser's reload
 * navigation type sets `Cache-Control: max-age=0` on every subresource,
 * forcing revalidation, and (b) by the time the user has noticed the
 * problem and pressed Cmd+R, Meta's per-IP rate-limit window has
 * usually had a few seconds to relax. We can't replicate (a) from JS —
 * `iframe.src = …` always uses the standard cache. But we *can*
 * replicate the side-effects of (b): fully tear down the iframe DOM
 * node, wait long enough for the browser/embed library to drop their
 * in-flight state and the CDN's rate-limit clock to tick, then mount
 * a brand-new iframe.
 *
 * The full sequence on click:
 *   1. Strip the platform's `<script>` tag — kills its cached
 *      MutationObserver so a re-injection re-evaluates from scratch.
 *   2. Set `dormant = true` → body unmounts → iframe DOM node
 *      removed → browser aborts the iframe's pending requests.
 *   3. Wait 1 000 ms.
 *   4. Set `dormant = false` and bump `reloadKey` → body re-mounts
 *      with a fresh DOM container; its effect re-injects a cache-
 *      busted script URL, attaches a new MutationObserver, and the
 *      blockquote → iframe handshake replays.
 *
 * This is a closer JS analogue to "the entire navigation tears down,
 * 100ms passes, the page comes back fresh" than any of the in-place
 * reload tricks we tried first. It can still fail when the
 * rate-limit window is longer than 1 s — in that case the click
 * needs to be repeated, or the user simply waits and refreshes.
 */
export function NativeEmbed({
  platform,
  permalink,
}: {
  platform: FeedPlatform;
  permalink: string;
}) {
  // Instagram/XHS have no embeddable script pipeline (XHS none at all;
  // Instagram's requires an app token) — reference tiles for them render as
  // a plain link card instead (feed-create-split.md D13). Hooks below this
  // guard only ever run for the script-embeddable platforms.
  if (platform === "instagram" || platform === "xhs") {
    return <LinkRefCard platform={platform} permalink={permalink} />;
  }
  return <ScriptEmbed platform={platform} permalink={permalink} />;
}

/**
 * Link-card reference tile for platforms without a native embed script —
 * platform icon + trimmed permalink + open-in-new-tab, in the app card
 * chrome. Deliberately quiet: the reference's content lives on the platform;
 * the card just keeps the source one click away.
 */
function LinkRefCard({
  platform,
  permalink,
}: {
  platform: FeedPlatform;
  permalink: string;
}) {
  const t = useT().feedPage;
  const label = t.platformLabels[platform];
  return (
    <a
      href={permalink}
      target="_blank"
      rel="noreferrer noopener"
      className="flex items-center gap-3 rounded-xl border border-border/60 bg-card px-4 py-3 shadow-xs hover:bg-accent/50 transition-colors"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-foreground/70">
        <PlatformIcon platform={platform} className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">{label}</span>
        <span className="block truncate text-[12px] text-muted-foreground">
          {prettyPermalink(permalink)}
        </span>
      </span>
      <span aria-hidden className="shrink-0 text-muted-foreground">
        ↗
      </span>
    </a>
  );
}

function ScriptEmbed({
  platform,
  permalink,
}: {
  platform: FeedPlatform;
  permalink: string;
}) {
  const t = useT().feedPage;
  const containerRef = useRef<HTMLDivElement>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [dormant, setDormant] = useState(false);
  const [reloading, setReloading] = useState(false);
  // True after MAX_AUTO_RETRIES silent failures — makes the button
  // permanently visible so the user knows a manual retry is needed.
  const [failed, setFailed] = useState(false);
  const autoRetryCount = useRef(0);
  const MAX_AUTO_RETRIES = 2;

  useEffect(() => {
    autoRetryCount.current = 0;
    setFailed(false);
  }, [permalink]);

  function doReload() {
    const marker =
      platform === "threads"
        ? "data-sidan-threads-embed"
        : "data-sidan-twitter-widgets";
    document.querySelectorAll(`script[${marker}]`).forEach((s) => s.remove());
    setDormant(true);
    setReloading(true);
    setTimeout(() => {
      setDormant(false);
      setReloadKey((k) => k + 1);
    }, 1000);
    setTimeout(() => setReloading(false), 2500);
  }

  function reload() {
    // Manual click: reset retry counter so the user gets fresh auto-retries.
    autoRetryCount.current = 0;
    setFailed(false);
    doReload();
  }

  // Called by NativeEmbedBody when the 4 s safety timeout fires without
  // any real load signal (no `load` event, no ResizeObserver resize).
  // Auto-retries up to MAX_AUTO_RETRIES; after that surfaces the button
  // permanently so the user can intervene.
  const onLoadFailed = useCallback(() => {
    if (autoRetryCount.current >= MAX_AUTO_RETRIES) {
      setFailed(true);
      return;
    }
    autoRetryCount.current++;
    doReload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  return (
    <div className="group/embed relative">
      {failed ? (
        <EmbedFailedFallback platform={platform} permalink={permalink} onRetry={reload} />
      ) : dormant ? (
        <div className="relative min-h-44">
          <div aria-hidden className="absolute inset-0 pointer-events-none">
            <EmbedSkeleton />
          </div>
        </div>
      ) : (
        <NativeEmbedBody
          key={reloadKey}
          platform={platform}
          permalink={permalink}
          reloadKey={reloadKey}
          containerRef={containerRef}
          onLoadFailed={onLoadFailed}
        />
      )}
      {!failed && (
        <button
          type="button"
          title={t.postEmbed.reloadPost}
          aria-label={t.postEmbed.reloadPost}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            reload();
          }}
          className="absolute top-2 right-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md bg-card/85 text-muted-foreground shadow-sm backdrop-blur-sm opacity-0 group-hover/embed:opacity-100 focus-visible:opacity-100 hover:text-foreground hover:bg-card transition-opacity"
        >
          <ReloadIcon spinning={reloading} />
        </button>
      )}
    </div>
  );
}

function NativeEmbedBody({
  platform,
  permalink,
  reloadKey,
  containerRef,
  onLoadFailed,
}: {
  platform: FeedPlatform;
  permalink: string;
  reloadKey: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Called when the 4 s timeout fires with no real load signal, so the
   *  outer wrapper can auto-retry rather than revealing an empty iframe. */
  onLoadFailed?: () => void;
}) {
  const t = useT().feedPage;
  const [ready, setReady] = useState(false);
  // The fallback anchor's label — captured outside the effect so the
  // imperative DOM build below re-runs when the locale changes.
  const fallbackLabel = format(t.postEmbed.viewOnArrow, {
    platform: t.platformLabels[platform],
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setReady(false);
    const cleanups: Array<() => void> = [];

    const isThreads = platform === "threads";
    const src = isThreads
      ? "https://www.threads.com/embed.js"
      : "https://platform.twitter.com/widgets.js";
    const marker = isThreads
      ? "data-sidan-threads-embed"
      : "data-sidan-twitter-widgets";

    container.replaceChildren();
    const bq = document.createElement("blockquote");
    // Hide the source blockquote pre-iframe — keeping it in flow means the
    // fallback `View on …` anchor renders for ~150ms before the script
    // swaps in the iframe, which reads as a flicker. Pulling it out of
    // flow keeps it in the DOM (script can still find it) but invisible.
    //
    // Apply the hide via CSS classes, NOT inline `style.*` — Threads'
    // embed.js builds the iframe's style attribute by concatenating
    // `blockquote.style.cssText` with its own (`v.setAttribute('style',
    // r.style.cssText + ';' + u(b))`). Inline `position: absolute` /
    // `pointer-events: none` would be copied to the iframe, leaving it
    // out of flow (so following content overlaps behind it) and blocking
    // clicks on the spoiler / "View on Threads" controls. Class-applied
    // styles aren't reflected in `style.cssText`, so the iframe stays
    // in flow and interactive.
    const hideClasses = "absolute opacity-0 pointer-events-none";
    if (isThreads) {
      bq.className = `text-post-media ${hideClasses}`;
      bq.setAttribute("data-text-post-permalink", permalink);
    } else {
      bq.className = `twitter-tweet ${hideClasses}`;
      bq.setAttribute("data-dnt", "true");
    }
    const a = document.createElement("a");
    a.href = permalink;
    a.target = "_blank";
    a.rel = "noreferrer noopener";
    a.textContent = fallbackLabel;
    bq.appendChild(a);
    container.appendChild(bq);

    let cancelled = false;
    const reprocess = () => {
      if (cancelled) return;
      if (!isThreads) {
        const twttr = (
          window as {
            twttr?: { widgets?: { load?: (el?: HTMLElement) => void } };
          }
        ).twttr;
        twttr?.widgets?.load?.(container);
        return;
      }
      // Threads' embed.js does NOT use a MutationObserver — it scans
      // `.text-post-media` blockquotes once at init and once at +5s, then
      // stops. Any blockquote we add to the DOM after that window (e.g.
      // navigating to the detail page from the list page where embeds
      // already initialised the script) would never be picked up unless
      // we manually trigger a rescan. `window.instgrm.Embeds.process` is
      // the public hook that re-runs the scanner; calling it on every
      // (re)mount is idempotent because the script caches already-
      // processed blockquotes.
      const instgrm = (
        window as {
          instgrm?: { Embeds?: { process?: () => void } };
        }
      ).instgrm;
      instgrm?.Embeds?.process?.();
    };

    // Once the platform script lands an iframe in our container, hold
    // the iframe at `opacity: 0` and the skeleton at full opacity until
    // we have a strong "content has actually rendered" signal — then
    // fade both at once. Without the iframe-level hide, the skeleton
    // fades out while the iframe is still parsing its embed document
    // (the iframe element exists at its default ~150px size, but it's
    // empty), and the user sees a blank box where the post should be.
    //
    // The `ready` signal comes primarily from the iframe's `load`
    // event, which fires after Threads/X has parsed and rendered the
    // embed document — by that point the post body is in the iframe
    // and a height handshake will follow within a frame. Two fallbacks
    // cover the corner cases:
    //   (a) `ResizeObserver` reveal when the iframe height changes
    //       *from* its first observed size — catches cached iframes
    //       whose `load` event already fired before our listener
    //       attached, plus the rare case where our listener missed
    //       `load` entirely. We deliberately wait for a *change* (not
    //       just any non-zero height) so the iframe's pre-handshake
    //       default height doesn't fade the skeleton early.
    //   (b) 4s safety timeout, so a flaky network never strands the
    //       user on the skeleton forever.
    const wireIframe = (iframe: HTMLIFrameElement) => {
      if (iframe.dataset.sidanWired) return;
      iframe.dataset.sidanWired = "1";
      iframe.style.opacity = "0";
      iframe.style.transition = "opacity 280ms ease-out";
      // Defensive override: Threads' embed.js builds the iframe's
      // `style` attribute by concatenating `blockquote.style.cssText`
      // with its own. If anything ever sneaks `position` or
      // `pointer-events` onto the source blockquote (now hidden via
      // classes — see `hideClasses` above — but old cached scripts or
      // future regressions could re-introduce it), the iframe would
      // end up out of flow and click-blocked. Pin it back to in-flow
      // and interactive here, regardless of what was propagated.
      iframe.style.position = "static";
      iframe.style.pointerEvents = "auto";
      let revealed = false;
      // True once a real content signal arrives (load event or ResizeObserver
      // resize). The 4 s timeout checks this to decide whether to reveal
      // normally (signal was just late) or call onLoadFailed (no signal at all,
      // iframe silently failed — rate-limited, blocked, etc.).
      let hadRealSignal = false;
      // Set to true when onLoadFailed fires so a late-arriving load event
      // doesn't reveal a post that's already been queued for retry.
      let onLoadFailedFired = false;

      const reveal = () => {
        if (revealed || cancelled) return;
        revealed = true;
        // Two rAFs so the opacity-0 style is committed before flipping
        // to 1 — without this the transition is skipped on Safari.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (cancelled) return;
            iframe.style.opacity = "1";
            setReady(true);
          }),
        );
      };
      const realReveal = () => {
        if (onLoadFailedFired) return;
        hadRealSignal = true;
        reveal();
      };

      // `load` fires even for blank / error-page iframes (Threads returns a
      // gray page when rate-limited or the post is unavailable). We use it
      // only as a signal that the iframe document has settled, NOT as proof
      // that real content rendered. On `load` we start a shorter watchdog
      // (1.5 s) so that if no ResizeObserver height change ever arrives we
      // treat it as a silent failure rather than revealing a blank frame.
      let loadedAt: number | null = null;
      iframe.addEventListener(
        "load",
        () => {
          if (onLoadFailedFired || cancelled) return;
          loadedAt = Date.now();
        },
        { once: true },
      );

      if (typeof ResizeObserver !== "undefined") {
        let firstHeight: number | null = null;
        const ro = new ResizeObserver((entries) => {
          for (const e of entries) {
            const h = e.contentRect.height;
            if (firstHeight === null) {
              // Record the very first observation, *including* 0 —
              // Threads' embed.js creates the iframe with the
              // attribute `height="0"` and only sets a real height via
              // a postMessage handshake after the embed document
              // loads, so the size transition is `0 → final` in one
              // jump. If we skipped the 0 here, that single jump
              // would land in `firstHeight` and the change-detector
              // would never trip — the iframe stays at opacity 0
              // forever even though the post rendered. Recording the
              // 0 lets the subsequent non-zero height register as a
              // real handshake event.
              firstHeight = h;
              continue;
            }
            // Threads/X resize the iframe by at least a dozen px once
            // the handshake completes. Anything smaller than 10px we
            // treat as layout noise (scrollbar appearing, etc.).
            if (Math.abs(h - firstHeight) > 10) {
              ro.disconnect();
              realReveal();
              return;
            }
          }
        });
        ro.observe(iframe);
        cleanups.push(() => ro.disconnect());
      }

      // Primary timeout: 4 s. If no ResizeObserver height change has arrived
      // (and no `load` came early either) the iframe has silently failed.
      // If `load` fired but still no resize by the 4 s mark, also treat as
      // failed — the iframe loaded a blank/error document.
      // If ResizeObserver already confirmed content (`hadRealSignal`), nudge
      // reveal() in case it hasn't finished the rAF chain yet.
      const timeoutId = setTimeout(() => {
        if (cancelled) return;
        if (hadRealSignal) {
          reveal();
        } else if (loadedAt !== null) {
          // load fired but no content resize → blank iframe.
          onLoadFailedFired = true;
          onLoadFailed?.();
        } else {
          // No load event at all — network stall or blocked request.
          onLoadFailedFired = true;
          onLoadFailed?.();
        }
      }, 4000);
      cleanups.push(() => clearTimeout(timeoutId));
    };

    const hideObserver = new MutationObserver(() => {
      if (cancelled) return;
      const iframe = container.querySelector("iframe");
      if (!iframe) return;
      wireIframe(iframe);
    });
    hideObserver.observe(container, { childList: true, subtree: true });

    let script = document.querySelector<HTMLScriptElement>(`script[${marker}]`);
    if (!script) {
      script = document.createElement("script");
      // Cache-bust the script URL whenever a manual reload triggered
      // this remount (`reloadKey > 0`). Browsers can otherwise short-
      // circuit a re-added <script src="..."> with the same URL to just
      // firing `load` without re-evaluating the file, which means the
      // MutationObserver inside the script would never re-attach. The
      // initial load (`reloadKey === 0`) keeps the clean URL so the
      // first paint hits the browser cache cleanly.
      script.src = reloadKey > 0 ? `${src}?_=${reloadKey}` : src;
      script.async = true;
      script.setAttribute(marker, "true");
      document.body.appendChild(script);
    }
    script.addEventListener("load", reprocess);
    reprocess();

    return () => {
      cancelled = true;
      hideObserver.disconnect();
      script?.removeEventListener("load", reprocess);
      for (const fn of cleanups) fn();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, permalink, fallbackLabel]);

  return (
    // `min-h-44` only applies while the skeleton is mounted — it gives
    // the shimmer a visible footprint pre-iframe. Once the iframe is
    // ready we drop the floor so a short post doesn't leave dead space
    // below itself. The iframe lives in `containerRef` in the normal
    // flow at its full Threads / X-set height, so the wrapper grows
    // naturally for any post taller than the floor.
    //
    // We deliberately do NOT animate the wrapper's min-height. Earlier
    // revisions transitioned it to coordinate with the skeleton fade,
    // but the animation overlapped Threads' resize handshake and
    // produced mid-text content clipping.
    <div className={"relative " + (ready ? "" : "min-h-44")}>
      <div ref={containerRef} />
      {/* Skeleton overlay only mounts while loading. We previously kept
          it mounted at `opacity: 0` after `ready` for the fade-out, but
          an absolute sibling — even with `pointer-events: none` —
          interfered with clicks on the Threads / X iframe's internal
          UI (e.g. "View on Threads", spoiler reveal). Unmounting on
          ready makes the iframe the sole occupant of the wrapper, so
          its native click handling works without exception. The
          fade-in on the iframe itself (`wireIframe` opacity transition)
          carries the polish; the skeleton just vanishes when the post
          is ready, which is fine because the iframe content fades in
          immediately afterwards. */}
      {!ready ? (
        <div aria-hidden className="absolute inset-0 pointer-events-none">
          <EmbedSkeleton />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Shown after MAX_AUTO_RETRIES silent failures. Gives the user a direct link
 * to the post (always available since we have the permalink) and a "Try again"
 * button that resets the retry counter and re-attempts the embed.
 */
function EmbedFailedFallback({
  platform,
  permalink,
  onRetry,
}: {
  platform: FeedPlatform;
  permalink: string;
  onRetry: () => void;
}) {
  const t = useT().feedPage;
  const label = t.platformLabels[platform];
  return (
    <div className="min-h-44 rounded-lg border border-border bg-muted/30 flex flex-col items-center justify-center gap-3 py-6 px-4">
      <p className="text-sm text-muted-foreground">{t.postEmbed.embedUnavailable}</p>
      <div className="flex items-center gap-2">
        <a
          href={permalink}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          {format(t.postEmbed.openOnArrow, { platform: label })}
        </a>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRetry();
          }}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium border border-border bg-background hover:bg-muted transition-colors"
        >
          {t.postEmbed.tryAgain}
        </button>
      </div>
    </div>
  );
}

function ReloadIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={spinning ? "animate-spin" : undefined}
    >
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

/**
 * Pre-paint skeleton for `NativeEmbed`. A single shimmer block that
 * fills the wrapper at whatever height it ends up — avoids a structured
 * `avatar / text rows / media` silhouette that would either dwarf a
 * short post or sit awkwardly small inside a tall one. Uses the global
 * `.skeleton` shimmer utility (which already handles
 * `prefers-reduced-motion`).
 *
 * Exported because the list page also uses this from `LazyMount`'s
 * placeholder — keeping the two skeletons identical means the swap from
 * "scroll into view" to "iframe loading" is visually invisible.
 */
export function EmbedSkeleton() {
  return <div className="skeleton h-full w-full min-h-44 rounded-none" />;
}

/**
 * Module-level FIFO stagger queue for iframe mounts. Threads' `embed.js`
 * and X's `widgets.js` pull a fresh signed iframe URL per blockquote, and
 * a 16-card grid hammering both CDNs in the same paint frame can trip
 * Meta's per-IP embed rate limit (the iframe falls back to "Sorry, this
 * post couldn't be loaded"). Spacing the mounts by ~350ms turns the
 * burst into a stream the embed scripts and CDNs both tolerate.
 *
 * Each `LazyMount` reserves the head of the chain, then appends a
 * timer-padded link for the next mount to wait on. The chain is shared
 * across every `LazyMount` on the page, so newly-scrolled-into-view cards
 * land at the back of whatever's already queued.
 */
let mountChain: Promise<void> = Promise.resolve();
const MOUNT_STAGGER_MS = 350;

function reserveMountSlot(): Promise<void> {
  const waitFor = mountChain;
  mountChain = waitFor.then(
    () => new Promise<void>((resolve) => setTimeout(resolve, MOUNT_STAGGER_MS)),
  );
  return waitFor;
}

/**
 * Defer rendering `children` until the wrapper enters the viewport AND a
 * slot in the global mount-stagger queue opens up. Used by the draft-
 * sessions list page so a 16-card grid doesn't mount 16 Threads/X embed
 * iframes on initial paint.
 *
 * Two-stage gate:
 *   1. **Viewport gate** — `IntersectionObserver` flips `intersected` once
 *      the wrapper actually enters the viewport. The default `rootMargin`
 *      is `0px` (no pre-load) so above-the-fold cards still fire on
 *      mount, but cards below the fold wait for real scroll — the user
 *      asked for "load only when scrolling".
 *   2. **Stagger gate** — once `intersected`, the card joins the FIFO
 *      `mountChain`. The first mount runs immediately; each subsequent
 *      mount waits `MOUNT_STAGGER_MS` after the previous. So 4 cards
 *      visible above the fold mount over ~1s instead of all at once,
 *      keeping us under the embed-CDN burst limit.
 *
 * Once mounted, the wrapper stays mounted — scrolling back out does NOT
 * unmount, so the embed's iframe state and any user interaction (paused
 * video, expanded thread) survive scroll.
 */
export function LazyMount({
  children,
  placeholder,
  className,
  rootMargin,
}: {
  children: ReactNode;
  placeholder?: ReactNode;
  className?: string;
  rootMargin?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [intersected, setIntersected] = useState(false);
  const [visible, setVisible] = useState(false);

  // Stage 1: wait for the wrapper to enter the viewport.
  useEffect(() => {
    if (intersected) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setIntersected(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setIntersected(true);
            obs.disconnect();
            return;
          }
        }
      },
      { rootMargin: rootMargin ?? "0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [intersected, rootMargin]);

  // Stage 2: once intersected, claim a slot in the global stagger queue.
  // Multiple cards entering the viewport at the same paint (the
  // above-the-fold case) all hit this effect synchronously; the chain
  // serialises their `setVisible(true)` so only one iframe mounts every
  // ~350ms.
  useEffect(() => {
    if (!intersected || visible) return;
    let cancelled = false;
    void reserveMountSlot().then(() => {
      if (!cancelled) setVisible(true);
    });
    return () => {
      cancelled = true;
    };
  }, [intersected, visible]);

  return (
    <div ref={ref} className={className}>
      {visible ? children : (placeholder ?? null)}
    </div>
  );
}

/**
 * Threads/X-style preview card showing the team's draft body — rendered on
 * the draft-sessions list when a session has no reply target (original
 * posts and freeform sessions). The avatar + handle come from the team's
 * connected profile; body is the latest `proposeDrafts` option pulled by
 * the list query.
 *
 * No iframe, no script load — pure CSS, so it renders instantly on every
 * card without competing with the lazy-mounted iframe path.
 *
 * Two visual modes:
 *   - **default** (original-post tile, detail-page surfaces): full
 *     bordered card with avatar + @handle + DRAFT badge header above the
 *     body.
 *   - **compact** (list reply card): a single inline row of `[avatar]
 *     [draft text]` — no header, no internal borders. The outer Link
 *     card frames it; the `ReplyConnector` above carries the "this is
 *     the team's draft" label so the handle/badge would just be repeat
 *     chrome inside an already-tight tile.
 */
export function PostDraftPreview({
  platform,
  authorHandle,
  text,
  avatarUrl,
  compact,
}: {
  platform: FeedPlatform;
  authorHandle: string;
  text: string;
  /** Connected account's profile picture URL (Threads `/me`). When set,
   *  renders as the avatar; missing or load-failure falls back to the
   *  letter circle so pre-migration-105 connections (and X) still render
   *  cleanly without a broken-image icon. */
  avatarUrl?: string | null;
  /** Reply cards have a parent tile + connector above this one — render as a
   *  single inline `[avatar] [text]` row instead of a full bordered card. */
  compact?: boolean;
}) {
  const t = useT().feedPage;
  const isX = platform === "twitter";
  if (compact) {
    return (
      <article className="flex items-start gap-2.5 px-1 pt-0.5">
        <ProfileAvatar
          url={avatarUrl ?? null}
          handle={authorHandle}
          size={28}
          isX={isX}
          textSize="text-[11px]"
        />
        <p className="flex-1 min-w-0 text-[13px] leading-[1.5] whitespace-pre-wrap break-words line-clamp-4">
          {text}
        </p>
      </article>
    );
  }
  return (
    <article className="rounded-xl border border-border/60 bg-card overflow-hidden shadow-xs">
      <div className="flex items-center gap-3 px-4 pt-3 pb-2 border-b border-border/60">
        <ProfileAvatar
          url={avatarUrl ?? null}
          handle={authorHandle}
          size={32}
          isX={isX}
          textSize="text-xs"
        />
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <span className="text-sm font-semibold truncate">
            @{authorHandle}
          </span>
          <span className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold bg-primary/15 text-primary uppercase tracking-wide">
            {t.postEmbed.draftBadge}
          </span>
        </div>
      </div>
      <div className="px-4 py-3">
        <p className="text-[14px] leading-[1.55] whitespace-pre-wrap break-words line-clamp-6">
          {text}
        </p>
      </div>
    </article>
  );
}

/**
 * Small avatar that prefers a real profile picture URL but gracefully
 * falls back to a letter circle when the URL is missing or the image
 * fails to load (404, blocked by tracker filter, etc.). Used by both
 * `PostDraftPreview` (team avatar, larger) and `QuotedPostPreview`
 * (parent author avatar, smaller).
 *
 * Sized via the `size` prop in pixels — the parent's `gap` and the
 * neighbouring text sizing scale around 28-32px. Tailwind `w-N`
 * utilities don't accept dynamic class names safely, so the size is
 * applied as inline styles to avoid broken JIT classes.
 */
function ProfileAvatar({
  url,
  handle,
  size,
  isX,
  textSize,
}: {
  url: string | null;
  handle: string;
  size: number;
  isX: boolean;
  textSize: string;
}) {
  const initial = handle.charAt(0).toUpperCase() || "?";
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={`@${handle}`}
        width={size}
        height={size}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="shrink-0 rounded-full object-cover bg-muted"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className={`shrink-0 rounded-full ${
        isX ? "bg-foreground text-background" : "bg-primary/20 text-primary"
      } flex items-center justify-center font-semibold ${textSize}`}
      style={{ width: size, height: size }}
    >
      {initial}
    </div>
  );
}

/**
 * Compact (no-iframe) preview of the post being replied to — the upper tile
 * in a reply card. Renders the parent author + the quoted text in a muted
 * Threads/X-style card so the reviewer sees what the team is responding to
 * without the cost of mounting a third-party embed iframe per card. The
 * detail page still loads the full iframe via `NativeEmbed`.
 *
 * `permalink` is optional — when present, the muted "View on {platform}"
 * link gives one click to the source. The reviewer-clicks-through case is
 * rare on the list (clicking the card opens the draft session); the link
 * is mostly to confirm the embedded text matches the live post.
 */
export function QuotedPostPreview({
  platform,
  authorHandle,
  text,
  permalink,
}: {
  platform: FeedPlatform;
  authorHandle: string;
  text: string;
  permalink?: string | null;
}) {
  const t = useT().feedPage;
  const isX = platform === "twitter";
  const initial = authorHandle.charAt(0).toUpperCase() || "?";
  return (
    // No outer border — the parent Link card on the draft-sessions list is
    // the bordered shell. Subtle muted background distinguishes the parent
    // post from the team's own draft tile below the connector.
    <article className="bg-muted/40 overflow-hidden rounded-md">
      <div className="flex items-center gap-3 px-4 pt-3 pb-2">
        <div
          className={`w-7 h-7 shrink-0 rounded-full ${
            isX ? "bg-foreground text-background" : "bg-primary/15 text-primary"
          } flex items-center justify-center text-[11px] font-semibold`}
        >
          {initial}
        </div>
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <span className="text-[13px] font-semibold truncate">
            @{authorHandle}
          </span>
          <span className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold bg-background/60 text-muted-foreground uppercase tracking-wide">
            {t.postEmbed.replyingTo}
          </span>
        </div>
      </div>
      <div className="px-4 pb-3">
        {text ? (
          <p className="text-[13px] leading-[1.5] text-muted-foreground whitespace-pre-wrap break-words line-clamp-3">
            {text}
          </p>
        ) : permalink ? (
          // URL-paste flow: we know the handle + permalink but not the
          // post body. Show a single-line teaser pointing at the source so
          // the reviewer can jump to the original post for context.
          <a
            href={permalink}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            className="text-[13px] leading-[1.5] text-primary hover:underline break-all line-clamp-1"
          >
            {prettyPermalink(permalink)} ↗
          </a>
        ) : (
          <p className="text-[12px] italic text-muted-foreground">
            {t.postEmbed.postBodyUnavailable}
          </p>
        )}
        {text && permalink ? (
          <a
            href={permalink}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            className="mt-1.5 inline-block text-[11px] text-muted-foreground/80 hover:text-foreground hover:underline"
          >
            {format(t.postEmbed.viewOnArrow, {
              platform: t.platformLabels[platform],
            })}
          </a>
        ) : null}
      </div>
    </article>
  );
}

/** Strip protocol + leading "www." for compact subtitle display. */
function prettyPermalink(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * The thin "│ ↳ Reply draft" connector between the parent quote tile and
 * the draft tile. The short vertical stroke above the arrow visualises the
 * thread continuing from the parent post into our reply, so the eye reads
 * the two posts as a connected pair rather than independent siblings. The
 * arrow + label then make the relationship explicit ("this is OUR reply
 * to the post above").
 *
 * The stroke is offset to align with the centre of the avatar in the
 * `[avatar] [draft text]` row immediately below — this keeps the visual
 * thread line continuous from the parent tile, through the connector,
 * down to the draft author's circle.
 */
export function ReplyConnector() {
  const t = useT().feedPage;
  return (
    // No side borders — the outer Link card on the list page now frames
    // the whole stack, so the connector reads as an inline label between
    // the two tiles rather than a third bordered seam.
    <div className="px-1 pt-1.5">
      <div
        aria-hidden
        // 14px = half the 28px avatar in the compact draft row below, so
        // the stroke + arrow + avatar all share a vertical centre line.
        className="ml-[14px] w-px h-3 bg-border/80"
      />
      <div className="flex items-center gap-1.5 pt-0.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span aria-hidden className="text-base leading-none">
          ↳
        </span>
        <span>{t.postEmbed.replyDraft}</span>
      </div>
    </div>
  );
}
