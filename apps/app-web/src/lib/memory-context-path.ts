export const MEMORY_CONTEXT_WORKSPACE_PATH = "/brain/context";

export function memoryContextPath(workspaceId: string, memoryId?: string): string {
  const path = `/w/${encodeURIComponent(workspaceId)}${MEMORY_CONTEXT_WORKSPACE_PATH}`;
  return memoryId ? `${path}?memory=${encodeURIComponent(memoryId)}` : path;
}
