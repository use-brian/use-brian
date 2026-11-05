import type { ReactNode } from "react";
import { WorkspaceSessionLayout } from "@/components/workspace-session-layout";

/** Shared root session boundary admits this workspace before mounting its shell. */
export default async function WorkspaceLayout({ children, params }: {
  children: ReactNode; params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <WorkspaceSessionLayout workspaceId={workspaceId}>{children}</WorkspaceSessionLayout>;
}
