import { authFetch } from "@/lib/auth-fetch";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import type { ComputerTask } from "./computer";

export const protectedFields = ["name", "email", "phone", "company", "jobTitle", "address", "website"] as const;
export type ProtectedField = typeof protectedFields[number];
export type ProtectedScope = {
  workspaceId: string; sessionId: string; taskId: string;
  browserProfileId: string; destinationOrigin: string;
};
export type ProtectedReferences = {
  references: { referenceId: string; field: ProtectedField }[];
  expiresAt: number;
};
const denied = () => new Error("Protected fill unavailable");

/** Never infer HTTPS from injectedSite, an address-bar draft, or chat text. */
export function protectedScope(task: ComputerTask, workspaceId: string, sessionId: string): ProtectedScope | null {
  if (task.backend !== "local" || !["running", "paused"].includes(task.status) ||
    task.workspaceId !== workspaceId || !task.profileId || !task.taskId || !sessionId ||
    task.connectionState !== "connected" || !task.destinationOrigin) return null;
  try {
    const url = new URL(task.destinationOrigin);
    if (url.protocol !== "https:" || url.origin !== task.destinationOrigin) return null;
    return { workspaceId, sessionId, taskId: task.taskId, browserProfileId: task.profileId, destinationOrigin: url.origin };
  } catch { return null; }
}

/** Reconstruct the allowlisted response. Never forward extra server properties. */
export function safeReferences(body: unknown, fields: ProtectedField[], now = Date.now()): ProtectedReferences {
  const data = body as ProtectedReferences;
  if (!data || !Number.isFinite(data.expiresAt) || data.expiresAt <= now || data.expiresAt > now + 120_000 ||
    !Array.isArray(data.references) || data.references.length !== fields.length || !fields.length || fields.length > 20) throw denied();
  const ids = new Set<string>();
  const seen = new Set<ProtectedField>();
  const references = data.references.map((item) => {
    if (!item || typeof item.referenceId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(item.referenceId) ||
      !protectedFields.includes(item.field) || !fields.includes(item.field) || ids.has(item.referenceId) || seen.has(item.field)) throw denied();
    ids.add(item.referenceId); seen.add(item.field);
    return { referenceId: item.referenceId, field: item.field };
  });
  return { references, expiresAt: data.expiresAt };
}

export async function createProtectedReferences(scope: ProtectedScope, entityId: string, fields: ProtectedField[]): Promise<ProtectedReferences> {
  try {
    if (!fields.length || fields.length > 20 || new Set(fields).size !== fields.length || fields.some(f => !protectedFields.includes(f))) throw denied();
    const response = await authFetch(`${publicRuntimeConfig().apiUrl ?? "http://localhost:4000"}/api/protected-browser-fill/references`, {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ ...scope, sources: fields.map(field => ({ kind: "crm", entityId, field })) }),
    });
    if (response.status !== 201) throw denied();
    return safeReferences(await response.json(), fields);
  } catch { throw denied(); }
}

/** Machine metadata only: no record identity, names, values, origin or scope IDs. */
export function protectedReferenceHandoff(result: ProtectedReferences): string {
  const safe = safeReferences(result, result.references.map(r => r.field));
  return JSON.stringify({ references: safe.references });
}
