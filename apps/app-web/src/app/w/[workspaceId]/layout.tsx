import { redirect } from "next/navigation";
import { serverApiFetch } from "@/lib/server-fetch";
import { WorkspaceContextProvider } from "@/lib/workspace-context";
import { CustomThemesProvider } from "@/lib/custom-themes";
import { DocSidebarDataProvider } from "@/components/doc/doc-sidebar-data";
import { BrainSurfaceProvider } from "@/contexts/brain-surface-context";
import { WorkspaceChrome } from "@/components/doc/workspace-chrome";

type TeamApiResponse = {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  clearance?: "public" | "internal" | "confidential";
  me?: { id: string };
};

/**
 * Server-component shell for everything under `/w/[workspaceId]/`. Loads
 * the workspace identity and provides it to the client tree via
 * `WorkspaceContextProvider` so child pages can resolve the workspace
 * name + role without re-querying. The proxy already required an access
 * token to reach this layout.
 *
 * 403 on the workspace fetch (non-member) → redirect to `/teams` so the
 * picker can offer the user one of their other workspaces.
 *
 * The PERSISTENT left sidebar is mounted here (`WorkspaceChrome`), wrapping
 * every surface under this segment — the doc page tree (`/p`), Brain,
 * Studio, Workflow, Approvals, Knowledge-base. The sidebar's data + the
 * page-mutation handlers live in `DocSidebarDataProvider`, also mounted here
 * so the lists survive every `/w/[id]/*` navigation (a parent layout does not
 * remount on a child route change — including a `/p/<pageId>` soft swap). See
 * docs/architecture/features/doc.md §4 (the chrome hoist). The
 * doc page shell (`DocShell`, under `p/layout.tsx`) now renders only the
 * centre page + chat inside this chrome's `{children}` slot.
 */
export default async function WorkspaceLayout(props: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await props.params;

  const teamData = await serverApiFetch<Partial<TeamApiResponse>>(
    `/api/workspaces/${workspaceId}`,
  );
  if (!teamData?.id || !teamData.name || !teamData.role) {
    redirect("/teams");
  }
  const team = teamData as TeamApiResponse;

  return (
    <WorkspaceContextProvider
      value={{
        workspaceId,
        name: team.name,
        role: team.role,
        clearance: team.clearance ?? "internal",
        me: { id: team.me?.id ?? "" },
      }}
    >
      <CustomThemesProvider workspaceId={workspaceId}>
        <div className="flex h-screen w-full overflow-hidden bg-background">
          <DocSidebarDataProvider workspaceId={workspaceId}>
            <BrainSurfaceProvider workspaceId={workspaceId}>
              <WorkspaceChrome workspaceId={workspaceId}>
                {props.children}
              </WorkspaceChrome>
            </BrainSurfaceProvider>
          </DocSidebarDataProvider>
        </div>
      </CustomThemesProvider>
    </WorkspaceContextProvider>
  );
}
