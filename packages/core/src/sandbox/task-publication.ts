import type { SandboxTaskRecord } from './orchestrator.js'

export type BrowserTaskPublication = Pick<SandboxTaskRecord, 'taskId' | 'sessionId' | 'workspaceId' | 'userId' |
  'profileId' | 'profileAuthority' | 'executionAuthority' | 'sourceAuthority' | 'inputScope'>

/** Stable host-owned snapshot; never copy process-local authority callbacks. */
export function browserTaskPublicationSnapshot(task: BrowserTaskPublication): BrowserTaskPublication {
  return structuredClone({ taskId: task.taskId, sessionId: task.sessionId, workspaceId: task.workspaceId, userId: task.userId,
    profileId: task.profileId, profileAuthority: task.profileAuthority ?? null, executionAuthority: task.executionAuthority ?? null,
    sourceAuthority: task.sourceAuthority ?? null, inputScope: task.inputScope ?? null })
}
export function assertBrowserTaskPublication(expected: BrowserTaskPublication, current: BrowserTaskPublication | null): void {
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, ordered(v)])) : value
  if (!current || JSON.stringify(ordered(browserTaskPublicationSnapshot(current))) !== JSON.stringify(ordered(browserTaskPublicationSnapshot(expected)))) {
    throw Object.assign(new Error('Browser task protection changed. Start a new request.'), { code: 'profile_authority_denied' })
  }
}
export function browserPublicationBusy(): Error {
  return Object.assign(new Error('A browser download is being saved. Wait for it to finish, then check the action result before retrying.'),
    { code: 'browser_publication_busy', retrySafe: true })
}
