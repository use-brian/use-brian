import { z } from "zod";
import { authFetch } from "@/lib/auth-fetch";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";

const summary = z.object({ id: z.string().uuid(), summary: z.string() });
const memory = z.object({ summary: z.string(), detail: z.string().nullable(), updatedAt: z.string().datetime() });
const selection = z.object({ memory, receipt: z.string().optional() });
export type MemoryContextSummary = z.infer<typeof summary>;
export type MemoryContextSelection = z.infer<typeof selection>;

export class MemoryContextDenied extends Error {}

async function send(operation: string, body: object, signal?: AbortSignal) {
  const api = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";
  const response = await authFetch(`${api}/api/brain/memories/context/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
    cache: "no-store",
  });
  if ([401, 403, 404].includes(response.status)) throw new MemoryContextDenied();
  if (!response.ok) throw new Error("Memory context request failed");
  return response;
}

export async function findMemoryContext(workspaceId: string, query: string, signal: AbortSignal): Promise<MemoryContextSummary[]> {
  const response = await send("search", { workspaceId, query }, signal);
  return z.object({ memories: z.array(summary) }).parse(await response.json()).memories;
}

export async function fetchMemoryContext(workspaceId: string, id: string, purpose: "preview" | "copy", signal: AbortSignal): Promise<MemoryContextSelection> {
  const response = await send("read", { workspaceId, id, purpose }, signal);
  return selection.parse(await response.json());
}

export function reportMemoryContextCopy(receipt: string | undefined) {
  if (receipt) void send("copied", { receipt }, AbortSignal.timeout(5_000)).catch(() => {});
}
