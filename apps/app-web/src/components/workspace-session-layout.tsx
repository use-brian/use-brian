"use client";
import type { ReactNode } from "react";
import { useAppSession } from "./app-session";
import { WorkspaceContextProvider } from "@/lib/workspace-context";
import { CustomThemesProvider } from "@/lib/custom-themes";
import { DocSidebarDataProvider } from "./doc/doc-sidebar-data";
import { PrimaryAssistantProvider } from "@/contexts/primary-assistant";
import { BrainSurfaceProvider } from "@/contexts/brain-surface-context";
import { WorkspaceChrome } from "./doc/workspace-chrome";
import { PlanGate } from "./chrome/plan-gate";
import { ComputerLivePill } from "./chrome/computer-live-pill";
import { SupportDiagnosticsIndicator } from "./chrome/support-diagnostics-indicator";
import { BrowserAssistantBridge } from "./computer/browser-assistant-bridge";

/** Protected consumers use the shared admitted context only. [COMP:app-web/app-session] */
export function WorkspaceSessionLayout({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const { state } = useAppSession();
  const admission = state.admissions[workspaceId];
  if (admission?.kind !== "allowed") return null;
  const value = admission.value;
  return <WorkspaceContextProvider value={value}><CustomThemesProvider workspaceId={workspaceId}>
    <BrowserAssistantBridge />
    <div className="flex h-dvh w-full overflow-hidden bg-background">
      <PrimaryAssistantProvider workspaceId={workspaceId}>
        <DocSidebarDataProvider key={workspaceId} workspaceId={workspaceId} initialHomeApps={value.homeApps}>
          <BrainSurfaceProvider workspaceId={workspaceId}>
            <WorkspaceChrome workspaceId={workspaceId}>{children}</WorkspaceChrome>
          </BrainSurfaceProvider>
        </DocSidebarDataProvider>
      </PrimaryAssistantProvider>
      <PlanGate workspaceId={workspaceId} /><ComputerLivePill workspaceId={workspaceId} />
      <SupportDiagnosticsIndicator workspaceId={workspaceId} />
    </div>
  </CustomThemesProvider></WorkspaceContextProvider>;
}
