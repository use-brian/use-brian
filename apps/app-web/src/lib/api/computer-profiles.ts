import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";

export type ComputerProfile = {
  id: string; workspaceId: string; name: string;
  enabledAssistantIds: string[]; assistantRoutingNotes: Record<string, string>;
  deviceId: string | null; connected: boolean; canManage: boolean;
};
export type ComputerProfilePatch = Partial<Pick<ComputerProfile, "name">>;
export type ComputerProfileAssistantPatch = { enabled?: boolean; routingNote?: string };
const base = () => `${publicRuntimeConfig().apiUrl ?? "http://localhost:4000"}/api/native-computer/profiles`;
async function request<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const res = await authFetch(url, { method, cache: "no-store", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error("Computer profiles unavailable");
  return res.json();
}
export async function listComputerProfiles(workspaceId: string) {
  return (await request<{ profiles: ComputerProfile[] }>(`${base()}?${new URLSearchParams({ workspaceId })}`)).profiles;
}
export async function createComputerProfile(workspaceId: string, name: string) {
  return (await request<{ profile: ComputerProfile }>(base(), "POST", { workspaceId, name })).profile;
}
export async function updateComputerProfile(id: string, patch: ComputerProfilePatch) {
  return (await request<{ profile: ComputerProfile }>(`${base()}/${encodeURIComponent(id)}`, "PATCH", { name: patch.name })).profile;
}
/** Atomic per-assistant intent: never replay another assistant's stale grants or notes. */
export async function updateComputerProfileAssistant(id: string, assistantId: string, patch: ComputerProfileAssistantPatch) {
  const body = {
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.routingNote === undefined ? {} : { routingNote: patch.routingNote }),
  };
  return (await request<{ profile: ComputerProfile }>(`${base()}/${encodeURIComponent(id)}/assistants/${encodeURIComponent(assistantId)}`, "PATCH", body)).profile;
}
export async function deleteComputerProfile(id: string) {
  await request<{ ok: true }>(`${base()}/${encodeURIComponent(id)}`, "DELETE");
}

/** Live owner-only list, refreshed on focus and after writes. Never reuse another scope's read. */
export function useComputerProfiles(workspaceId: string) {
  const [profiles, setProfiles] = useState<ComputerProfile[] | null>(null);
  const [error, setError] = useState(false);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const token = ++revision.current;
    try {
      const rows = await listComputerProfiles(workspaceId);
      if (token !== revision.current) return;
      setProfiles(rows.filter(p => p.workspaceId === workspaceId && p.canManage === true)); setError(false);
    } catch { if (token === revision.current) { setProfiles(null); setError(true); } }
  }, [workspaceId]);
  useEffect(() => {
    setProfiles(null); setError(false); void refresh();
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    const timer = setInterval(focus, 5000);
    return () => { ++revision.current; clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [refresh]);
  return { profiles, error, refresh };
}
