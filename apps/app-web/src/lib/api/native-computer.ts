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

/** Normal task creation only. No device, native session or grant is involved. */
export async function createNativeContextTask(workspaceId: string, assistantId: string, conversationId: string, title: string): Promise<NativeContextTask> {
  const res = await authFetch(`${publicRuntimeConfig().apiUrl ?? "http://localhost:4000"}/api/native-computer/context-tasks`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, assistantId, conversationId, title }),
  });
  if (!res.ok) throw new Error("Native task creation unavailable");
  const body = await res.json() as { task: NativeContextTask };
  return body.task;
}
