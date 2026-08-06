"use client";

/**
 * Persistent Workflow shell — keeps the shared surface top bar above the
 * workflow list, board, and run-detail routes.
 *
 * Spec: docs/architecture/features/workflow.md → "Workflow top bar".
 */

import { useParams } from "next/navigation";
import { WorkflowTopbar } from "@/components/workflow/workflow-topbar";

export default function WorkflowLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ workspaceId: string }>();

  return (
    <div className="flex h-full w-full min-h-0 flex-col overflow-hidden">
      <WorkflowTopbar workspaceId={params.workspaceId ?? ""} />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
