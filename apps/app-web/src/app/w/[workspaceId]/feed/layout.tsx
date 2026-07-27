"use client";

/**
 * Feed surface layout — every `/w/[id]/feed/*` route renders inside the
 * `FeedSurfaceShell` (profiles context + readiness gate). The Create routes
 * are available in both editions; the nested platform layout owns the
 * hosted-only integration boundary.
 *
 * Ported operator app: docs/plans/feed-web-consolidation.md;
 * spec: docs/architecture/feed/operator-app.md.
 *
 * [COMP:app-web/feed-surface-shell]
 */

import { useParams } from "next/navigation";
import { FeedSurfaceShell } from "@/components/feed/feed-surface-shell";

export default function FeedLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  return <FeedSurfaceShell workspaceId={workspaceId}>{children}</FeedSurfaceShell>;
}
