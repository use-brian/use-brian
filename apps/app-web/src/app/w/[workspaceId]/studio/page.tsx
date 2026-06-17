import { redirect } from "next/navigation";

/**
 * Default Studio route (app-web) — redirects to the Connectors section, the
 * top of the rail and the start of the setup journey (the sidebar's
 * cold-start "Set up" nudge points at connecting a first source). It
 * previously pointed at Assistants, which highlighted a mid-rail row on
 * landing. Spec: docs/architecture/features/studio.md → IA.
 */
export default async function StudioRoot(props: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await props.params;
  redirect(`/w/${workspaceId}/studio/connectors`);
}
