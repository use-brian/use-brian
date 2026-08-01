/** Legacy link shim: Task rules now belongs to the Tasks operator app. */
import { redirect } from "next/navigation";

export default async function LegacyStudioTaskRulesPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  redirect(`/w/${workspaceId}/tasks?task-settings=rules`);
}
