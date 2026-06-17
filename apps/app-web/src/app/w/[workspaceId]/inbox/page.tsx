/**
 * Legacy redirect for the old standalone Inbox route — `/w/[workspaceId]/inbox`.
 *
 * The Inbox is no longer a standalone page. It's now a flyout panel anchored to
 * the left bar (`inbox-panel.tsx`, toggled from the sidebar's Inbox row, owned
 * by `<DocShell>`), so the user never leaves their current page to read it.
 * Any old link/bookmark to this path lands back on the doc surface.
 *
 * Spec: `docs/architecture/features/doc-inbox.md`.
 *
 * [COMP:app-web/inbox-route]
 */

import { redirect } from "next/navigation";

export default async function WorkspaceInboxRedirect(props: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await props.params;
  redirect(`/w/${workspaceId}/p`);
}
