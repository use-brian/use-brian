"use client";

/**
 * Company voice — the rules EVERY platform inherits (feed-revamp.md §8a,
 * D13). A platform's own rules live at `/feed/[platform]/voice`.
 *
 * Feed voice route — the team voice-memories surface. Thin wrapper: the
 * meat lives in `@/components/feed/feed-voice` (`[COMP:app-web/feed-voice]`)
 * so the desktop SPA can import the client component directly
 * (docs/plans/feed-web-consolidation.md §6, §10). No `useSearchParams`, so
 * no Suspense boundary is needed.
 */

import { FeedVoice } from "@/components/feed/feed-voice";

export default function FeedVoicePage() {
  return <FeedVoice scope="company" />;
}
