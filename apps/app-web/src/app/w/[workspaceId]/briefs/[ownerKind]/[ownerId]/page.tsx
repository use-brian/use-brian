"use client";

/**
 * Stable Brief route for a Department (the Pages sidebar entry) or a shared
 * Project: renders the shared Brief pane over the canonical Brief Page
 * (project-briefs.md -> "User experience"). [COMP:app-web/brief-journey]
 */
import { use } from "react";
import { BriefPane } from "@/components/briefs/brief-pane";
import { useT } from "@/lib/i18n/client";

export default function BriefPage({ params }: { params: Promise<{ workspaceId: string; ownerKind: string; ownerId: string }> }) {
  const { workspaceId, ownerKind, ownerId } = use(params);
  const t = useT().briefs;
  const kind = ownerKind === "department" ? "department" : "project";
  return <main className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6 md:px-8">
    <h1 className="text-xl font-semibold">{t.entryTitle}</h1>
    <BriefPane workspaceId={workspaceId} ownerKind={kind} ownerId={ownerId} pageHref={pageId => `/w/${workspaceId}/p/${pageId}`} />
  </main>;
}
