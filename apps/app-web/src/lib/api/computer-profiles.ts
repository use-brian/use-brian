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
export type ComputerProfileErrorCode = "computer_profiles_schema_unavailable" | "computer_profiles_unavailable" | "computer_profiles_forbidden" | "native_execution_unavailable" | "api_not_supported" | "sign_in_required" | "network_unreachable" | "computer_profiles_duplicate";
/** Only allowlisted codes and HTTP status cross the API boundary, never server text. */
export class ComputerProfileError extends Error {
  constructor(public readonly code: ComputerProfileErrorCode, public readonly status?: number) {
    super(code); this.name = "ComputerProfileError";
  }
}
export function computerProfileErrorCode(error: unknown): ComputerProfileErrorCode {
  return error instanceof ComputerProfileError ? error.code : "computer_profiles_unavailable";
}
export function blocksComputerProfileCreation(code: ComputerProfileErrorCode | null | undefined) {
  return code === "api_not_supported" || code === "computer_profiles_schema_unavailable" || code === "sign_in_required" || code === "computer_profiles_forbidden";
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function validProfile(value: unknown): value is ComputerProfile {
  return record(value) && [value.id, value.workspaceId, value.name].every(v => typeof v === "string" && v.trim().length > 0)
    && Array.isArray(value.enabledAssistantIds) && value.enabledAssistantIds.every(v => typeof v === "string" && v.length > 0)
    && record(value.assistantRoutingNotes) && Object.values(value.assistantRoutingNotes).every(v => typeof v === "string")
    && (value.deviceId === null || typeof value.deviceId === "string") && typeof value.connected === "boolean" && typeof value.canManage === "boolean";
}
async function request<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await authFetch(url, { method, cache: "no-store", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  } catch { throw new ComputerProfileError("network_unreachable"); }
  let data: unknown;
  try { data = await res.json(); } catch { /* Never retain response text. */ }
  if (!res.ok) {
    const code = record(data) ? data.code : undefined;
    const safeCode: ComputerProfileErrorCode = res.status === 401 ? "sign_in_required"
      : res.status === 403 ? "computer_profiles_forbidden"
      : res.status === 404 ? "api_not_supported"
      : res.status === 503 && (code === "computer_profiles_schema_unavailable" || code === "native_execution_unavailable") ? code
      : res.status === 409 && code === "computer_profiles_duplicate" ? code
      : "computer_profiles_unavailable";
    throw new ComputerProfileError(safeCode, res.status);
  }
  if (res.headers.get("content-type")?.includes("text/html") || !record(data) || (method === "GET" ? !Array.isArray(data.profiles) || !data.profiles.every(validProfile)
    : method === "DELETE" ? data.ok !== true : !validProfile(data.profile))) {
    throw new ComputerProfileError("api_not_supported", res.status);
  }
  return data as T;
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
  const [errorCode, setErrorCode] = useState<ComputerProfileErrorCode | null>(null);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const token = ++revision.current;
    try {
      const rows = await listComputerProfiles(workspaceId);
      if (token !== revision.current) return;
      setProfiles(rows.filter(p => p.workspaceId === workspaceId && p.canManage === true)); setErrorCode(null);
    } catch (error) { if (token === revision.current) { setProfiles(null); setErrorCode(computerProfileErrorCode(error)); } }
  }, [workspaceId]);
  useEffect(() => {
    setProfiles(null); setErrorCode(null); void refresh();
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    const timer = setInterval(focus, 5000);
    return () => { ++revision.current; clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [refresh]);
  return { profiles, error: errorCode !== null, errorCode, refresh };
}
