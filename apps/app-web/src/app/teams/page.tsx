import { SessionWorkspacePicker } from "@/components/app-session";
import { safeWorkspaceNext } from "@/lib/legacy-paths";
export default async function TeamsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams; const raw = query.next;
  return <SessionWorkspacePicker next={safeWorkspaceNext(Array.isArray(raw) ? raw[0] : raw)} />;
}
