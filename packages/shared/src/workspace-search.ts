/** First-party workspace search contract. No provider scores or external URLs. */
export const WORKSPACE_SEARCH_FAMILIES = [
  'pages', 'knowledge', 'records', 'tasks', 'files', 'office', 'conversations', 'workflows',
] as const

export type WorkspaceSearchFamily = typeof WORKSPACE_SEARCH_FAMILIES[number]
export type WorkspaceSearchMatch = 'exact' | 'prefix' | 'tokens' | 'partial' | 'body'
export type WorkspaceSearchTarget =
  | { type: 'page'; id: string }
  | { type: 'knowledge'; id: string; path: string }
  | { type: 'brain'; id: string; primitive: 'memories' | 'people' | 'companies' | 'deals' | 'entities' | 'tasks' | 'files' }
  | { type: 'record'; id: string; entityTypeId: string }
  | { type: 'recording'; id: string; segmentIndex?: number }
  | { type: 'office'; id: string; family: 'document' | 'presentation' | 'spreadsheet'; contextId?: string }
  | { type: 'conversation'; id: string; visibility: 'personal' | 'workspace' }
  | { type: 'workflow'; id: string }

export type WorkspaceSearchItem = {
  key: string
  kind: WorkspaceSearchFamily
  id: string
  title: string
  snippet: string
  source: string
  updatedAt?: string
  status?: string
  match: WorkspaceSearchMatch
  target: WorkspaceSearchTarget
}

export type WorkspaceSearchRequest = {
  q: string
  kind?: WorkspaceSearchFamily
  limit?: number
  cursor?: string
}

export type WorkspaceSearchResponse = {
  items: WorkspaceSearchItem[]
  nextCursor: string | null
  completeness: 'complete' | 'partial'
  unavailableFamilies: WorkspaceSearchFamily[]
}

/** Shared by deterministic server ranking and the client's visible default. */
export function normalizeWorkspaceSearchText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
}

export function classifyWorkspaceSearchMatch(title: string, query: string): WorkspaceSearchMatch {
  const name = normalizeWorkspaceSearchText(title)
  const normalized = normalizeWorkspaceSearchText(query)
  if (!normalized) return 'body'
  if (name === normalized) return 'exact'
  if (name.startsWith(normalized)) return 'prefix'
  const tokens = normalized.split(' ')
  if (tokens.every(token => name.includes(token))) return 'tokens'
  if (tokens.some(token => name.includes(token))) return 'partial'
  return 'body'
}

export function isStrongWorkspaceSearchMatch(match: WorkspaceSearchMatch): boolean {
  return match === 'exact' || match === 'prefix' || match === 'tokens'
}
