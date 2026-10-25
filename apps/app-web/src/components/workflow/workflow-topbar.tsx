"use client";

/** Workflow identity in the common app header. [COMP:app-web/workflow-topbar]
 * Spec: docs/architecture/features/workspace-navigation.md → "Shared top bar". */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { GitBranch } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { useSidebarData } from "@/components/doc/doc-sidebar-data";
import { WorkspaceTopbar } from "@/components/chrome/workspace-topbar";
import { requestSidebarClose } from "@/lib/sidebar-close";

export function WorkflowTopbar({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const router = useRouter();
  const { sidebarCollapsed } = useSidebarData();
  const appIdentity = <Link data-workspace-app-identity href={`/w/${workspaceId}/workflow`} onClick={requestSidebarClose} className="flex min-w-0 items-center gap-2 rounded text-foreground hover:text-foreground/75">
    <GitBranch className="size-4 shrink-0" aria-hidden /><span className="truncate">{t.workflowPage.title}</span>
  </Link>;
  return (
    <WorkspaceTopbar identity={appIdentity} sidebarCollapsed={sidebarCollapsed} history={{ onBack: () => router.back(), onForward: () => router.forward() }}>

      <div className="min-w-0 flex-1" aria-hidden />
    </WorkspaceTopbar>
  );
}
