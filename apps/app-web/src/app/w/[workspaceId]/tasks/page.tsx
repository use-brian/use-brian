"use client";

/**
 * Tasks operator surface route — thin wrapper: the meat lives in
 * `@/components/tasks/tasks-surface` (`[COMP:app-web/tasks-surface]`) so the
 * desktop SPA can import the client component directly (the feed-port
 * disposition rule, feed-web-consolidation §6/§10). The Suspense boundary
 * covers `useSearchParams` (the filter codec + the dock card's
 * `?filter=stale` deep link).
 *
 * Spec: docs/architecture/features/tasks.md → "Operator surface".
 */

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { TasksSurface } from "@/components/tasks/tasks-surface";

export default function TasksPage() {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">…</div>}>
      <TasksSurface workspaceId={workspaceId} />
    </Suspense>
  );
}
