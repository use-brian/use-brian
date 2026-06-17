import { redirect } from "next/navigation";

/**
 * The workspace root in app-web is the doc surface itself —
 * server-side redirect to the canonical `/p` index (latest-or-empty).
 *
 * Post Doc v1 URL refactor (§9.3) the canonical page URL is
 * `/w/<id>/p/<pageId>`, and `/w/<id>/p` is the index that resolves
 * latest-or-empty. Redirecting the workspace root straight to `/p`
 * (rather than the legacy `/doc`, which only 302s onward to `/p`
 * anyway) keeps the URL bar canonical and saves a hop.
 */
export default async function WorkspaceRootPage(props: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ capture?: string }>;
}) {
  const { workspaceId } = await props.params;
  // Preserve the desktop quick-capture hint into the `/p` index so the shell
  // can open a fresh draft (see app-desktop.md → "quick-capture.ts").
  const { capture } = await props.searchParams;
  redirect(`/w/${workspaceId}/p${capture === "1" ? "?capture=1" : ""}`);
}
