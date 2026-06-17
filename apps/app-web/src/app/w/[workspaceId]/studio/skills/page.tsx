/**
 * Legacy URL - redirects to the Brain's Skills view, workspace-scoped.
 *
 * Skill management moved into the Brain (third view toggle, full library +
 * editor + agent-backed creator) per docs/plans/brain-skill-management-ux.md
 * §6 - this completes Phase 4 of the skills-as-procedural-brain-primitive
 * plan. Catalog browsing survives inside the creator's template picker;
 * per-assistant enablement survives on the assistant detail page. This shim
 * preserves bookmarks and external links that still point at the old URL
 * (mirrors the `memories/review` shim).
 *
 * [COMP:app-web/studio-skills]
 */

import { redirect } from "next/navigation";

export default async function StudioSkillsRedirect(props: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await props.params;
  redirect(`/w/${workspaceId}/brain?view=skills`);
}
