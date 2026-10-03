import type { WorkspaceSearchRequest, WorkspaceSearchResponse } from '@use-brian/shared'
import { authFetch } from '@/lib/auth-fetch'
import { publicRuntimeConfig } from '@/lib/runtime-public-config'

export async function searchWorkspace(workspaceId: string, input: WorkspaceSearchRequest, signal: AbortSignal): Promise<WorkspaceSearchResponse> {
  const params = new URLSearchParams({ q: input.q })
  if (input.kind) params.set('kind', input.kind)
  if (input.limit) params.set('limit', String(input.limit))
  if (input.cursor) params.set('cursor', input.cursor)
  const response = await authFetch(`${publicRuntimeConfig().apiUrl ?? 'http://localhost:4000'}/api/workspace-search/${encodeURIComponent(workspaceId)}?${params}`, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error('Workspace search unavailable')
  return response.json() as Promise<WorkspaceSearchResponse>
}
