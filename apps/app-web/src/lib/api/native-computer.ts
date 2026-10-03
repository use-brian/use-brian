import { authFetch } from "@/lib/auth-fetch";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";

export type NativeContextTask = { id: string; title: string };
export async function fetchNativeContextTasks(workspaceId: string, assistantId: string, conversationId: string): Promise<NativeContextTask[]> {
  const params = new URLSearchParams({ workspaceId, assistantId, conversationId });
  const res = await authFetch(`${publicRuntimeConfig().apiUrl ?? "http://localhost:4000"}/api/native-computer/context-tasks?${params}`, { cache: "no-store" });
  if (!res.ok) throw new Error("Native context unavailable");
  const body = await res.json() as { tasks: NativeContextTask[] };
  return body.tasks;
}
