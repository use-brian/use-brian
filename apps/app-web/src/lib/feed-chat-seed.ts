/**
 * Tiny event bus for asking the FEED floating tuning chat to open with a
 * seeded composer — ported from `apps/feed-web/src/lib/chat-seed.ts`
 * (docs/plans/feed-web-consolidation.md §7.3). Used by feed surfaces that
 * nudge the operator into the tuning chat with a pre-written prompt — e.g.
 * the Voice page's per-rule "Discuss" button, which drops the operator into
 * the floating chat with the rule quoted in the composer.
 *
 * Why a custom event instead of a shared ref: the feed floating chat is
 * mounted once by `FeedSurfaceShell` as chrome, so a callsite deep in a
 * page (Voice, inbox, …) would otherwise need a global context just to
 * talk to it. One-shot CustomEvents keep the coupling loose — the shell can
 * open the master chat as-is, while contextual surfaces can also seed its
 * composer.
 *
 * NAME COLLISION NOTE: app-web already has `src/lib/chat-seed.ts` — the DOC
 * chat's seed bus (`doc:chat-seed`, richer payload). This file is the feed
 * surface's own bus with its own event name (`feed:chat-seed`, renamed from
 * feed-web's `sidan:chat-seed`) so the two buses can never cross-fire.
 *
 * [COMP:app-web/feed-tuning-chat]
 */

export type FeedChatSeed = {
  /** Composer prefill text. Required — empty seeds are dropped. */
  prefill: string;
  /**
   * Flip research mode on when the panel opens. Quota-gated server-side;
   * the toggle stays user-controllable in the composer.
   */
  researchMode?: boolean;
};

export const FEED_CHAT_SEED_EVENT = "feed:chat-seed";
export const FEED_CHAT_OPEN_EVENT = "feed:chat-open";

/** Open the persistent Feed control conversation without changing its composer. */
export function requestFeedChatOpen(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FEED_CHAT_OPEN_EVENT));
}

/**
 * Ask the feed floating chat to expand and drop the given text into its
 * composer. No-op on SSR. Returns immediately — the dock handles the
 * rest on the next tick.
 */
export function requestFeedChatSeed(seed: FeedChatSeed): void {
  if (typeof window === "undefined") return;
  if (!seed.prefill.trim()) return;
  window.dispatchEvent(
    new CustomEvent<FeedChatSeed>(FEED_CHAT_SEED_EVENT, { detail: seed }),
  );
}
