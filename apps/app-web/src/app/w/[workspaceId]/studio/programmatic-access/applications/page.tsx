"use client";

/** Dedicated application administration. [COMP:app-web/studio-application-management] */
import { ApplicationManagement } from "@/components/applications/application-admin";
import { BackButton } from "@/components/ui/back-button";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { useT } from "@/lib/i18n/client";

export default function ApplicationManagementPage() {
  const { workspaceId } = useWorkspaceContext();
  const t = useT();

  return <div className="min-w-0 space-y-4">
    <BackButton className="min-h-8 max-sm:min-h-11" label={t.studioPage.sections.programmaticAccess} href={`/w/${workspaceId}/studio/programmatic-access`}/>
    <ApplicationManagement/>
  </div>;
}
