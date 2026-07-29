/**
 * One-shot signal telling the Feed sidebar's post list to refetch.
 *
 * The post list lives in the SIDEBAR now (feed-revamp.md D14), and the sidebar
 * is mounted by the persistent `/w/[workspaceId]` layout, so it never
 * unmounts during SPA navigation. A mount-only effect there would fire once
 * per full page load and the list could never self-heal after the pane
 * created, renamed, or resolved a post - the exact persistent-layout bug the
 * root CLAUDE.md calls out.
 *
 * A CustomEvent rather than a context: the emitters are deep inside the pane
 * (the editor, the version chips, the approve/reject actions) and would
 * otherwise each need a provider threaded down just to say "the list moved".
 *
 * [COMP:app-web/feed-posts-events]
 */

export const FEED_POSTS_CHANGED_EVENT = "feed:posts-changed";

/** Ask the sidebar's post list to refetch. No-op on SSR. */
export function notifyFeedPostsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FEED_POSTS_CHANGED_EVENT));
}
