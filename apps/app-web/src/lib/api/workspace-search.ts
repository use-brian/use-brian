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

export type SearchItemPreview = {key:string;id:string;title:string;text:string;target:import('@use-brian/shared').WorkspaceSearchTarget;kind:import('@use-brian/shared').WorkspaceSearchFamily;status:string|null}
/** Always re-read identity before preview/open, including current department revocations. */
export async function readWorkspaceSearchItem(workspaceId:string,kind:import('@use-brian/shared').WorkspaceSearchFamily,key:string,signal:AbortSignal):Promise<SearchItemPreview> {
  const origin=publicRuntimeConfig().apiUrl ?? 'http://localhost:4000'
  const response=await authFetch(`${origin}/api/workspace-search/${encodeURIComponent(workspaceId)}/items/${kind}/${encodeURIComponent(key)}`,{signal,cache:'no-store'})
  if (!response.ok) throw new Error('Item unavailable')
  return response.json() as Promise<SearchItemPreview>
}

export async function previewWorkspaceSearchItem(workspaceId:string,item:import('@use-brian/shared').WorkspaceSearchItem,signal:AbortSignal):Promise<SearchItemPreview> {
  const {workspaceSearchDetailPath}=await import('../workspace-search-navigation')
  const path=workspaceSearchDetailPath(workspaceId,item.target)
  // Canonical detail read rechecks the owning app's authorization. The bounded
  // projection supplies safe text, avoiding tool payloads and arbitrary JSON.
  if (path) {
    const response=await authFetch(`${publicRuntimeConfig().apiUrl ?? 'http://localhost:4000'}${path}`,{signal,cache:'no-store'})
    if (!response.ok) throw new Error('Item unavailable')
    await response.body?.cancel()
  }
  return readWorkspaceSearchItem(workspaceId,item.kind,item.key,signal)
}
