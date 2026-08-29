"use client";

/**
 * Live operator surface route — thin wrapper: the meat lives in
 * `@/components/live/live-surface` (`[COMP:app-web/live-app]`) so the
 * desktop SPA can import the client component directly (the same
 * disposition rule as the Tasks surface).
 *
 * Spec: docs/architecture/features/live-work.md §8.
 */

import { useParams } from "next/navigation";
import { LiveSurface } from "@/components/live/live-surface";

export default function LivePage() {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  return <LiveSurface workspaceId={workspaceId} />;
}
