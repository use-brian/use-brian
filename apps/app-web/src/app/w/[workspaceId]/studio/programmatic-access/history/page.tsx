"use client";
import { useWorkspaces } from "@/contexts/workspace-context";
import { HistoryReader } from "@/components/engineering-history/history-reader";
import { ProgrammaticAccessShell } from "@/components/studio/programmatic-access-shell";
export default function EngineeringHistoryPage() {
  const { activeId } = useWorkspaces();
  return <ProgrammaticAccessShell active="capture">{activeId && <HistoryReader key={activeId} workspaceId={activeId} />}</ProgrammaticAccessShell>;
}
