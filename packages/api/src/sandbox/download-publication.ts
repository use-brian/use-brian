import { createHash } from 'node:crypto'
import {
  AuthoritySourceSchema, BrowserProfileAuthoritySchema, browserInputScope, parseBrowserInputScope, assertBrowserTaskPublication,
  parseAuthoringAuthority, maxSensitivity, deriveResourceScope,
  type FilesApi, type FilesContext, type SandboxTaskRecord, type ScopeSource, type CurrentAuthorityBoundary,
} from '@use-brian/core'
import { createAuthorityLease, runWithAuthorityLease } from '../context-scope/authority-lease.js'
import { runWithAgentAccess } from '../db/agent-access-context.js'
import { queryWithRLS } from '../db/client.js'
import { findAssistantById } from '../db/users.js'
import { resolveBrowserTaskExecutionAuthority } from './task-execution-authority.js'

export type DownloadTask = Pick<SandboxTaskRecord, 'taskId' | 'sessionId' | 'workspaceId' | 'userId' | 'profileId' |
  'profileAuthority' | 'executionAuthority' | 'sourceAuthority' | 'inputScope'>
export type BrowserDownload = { path: string; name: string; mime: string; bytes: Uint8Array
  /** Compute sandbox artifacts publish through the same retained-envelope admission. */
  origin?: 'browser-download' | 'compute-artifact' }
const denied = () => Object.assign(new Error('Browser download protection is unavailable. Check task access before retrying.'), { code: 'profile_authority_denied' })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const sameSet = (a: string[] | null | undefined, b: string[] | null | undefined) => same([...(a ?? [])].sort(), [...(b ?? [])].sort())

/** Host-only binding. The getter must return the same backend's active task. */
export async function prepareBrowserDownload(api: FilesApi, selected: DownloadTask,
  getCurrent: () => Promise<DownloadTask | null>, authority: CurrentAuthorityBoundary,
  withPublication: <T>(expected: DownloadTask, operation: () => Promise<T>) => Promise<T>) {
  if (!authority) throw denied()
  const original = structuredClone({ taskId: selected.taskId, sessionId: selected.sessionId, workspaceId: selected.workspaceId,
    userId: selected.userId, profileId: selected.profileId, profileAuthority: selected.profileAuthority,
    executionAuthority: selected.executionAuthority, sourceAuthority: selected.sourceAuthority, inputScope: selected.inputScope })
  const frozen = parseAuthoringAuthority(original.executionAuthority)
  const source = AuthoritySourceSchema.safeParse(original.sourceAuthority)
  if (!frozen || frozen.ceiling.workspaceId !== original.workspaceId || frozen.ceiling.userId !== original.userId
    || !source.success || (source.data.kind !== 'session' && source.data.kind !== 'workflow')
    || source.data.workspaceId !== original.workspaceId
    || source.data.kind === 'session' && (source.data.id !== original.sessionId || source.data.userId !== original.userId)
    || source.data.kind === 'workflow' && source.data.runId !== original.sessionId
    || source.data.authorityUserId !== original.userId
    || source.data.executingAssistantId !== frozen.assistantId || !original.inputScope) throw denied()
  const origin = source.data
  const history = parseBrowserInputScope(original.inputScope, original.workspaceId)
  const retained = await resolveBrowserTaskExecutionAuthority(original, authority)
  let currentInput = history
  let publishingHistory: string | null = null
  const lease = createAuthorityLease(frozen.ceiling, async () => {
    await authority.assertCurrent()
    await retained.assertCurrent()
    const task = await getCurrent()
    if (!task?.inputScope) return null
    assertBrowserTaskPublication({ ...original, inputScope: task.inputScope }, task)
    // Re-read cumulative history, never adopt a replacement task or narrower turn.
    const latest = parseBrowserInputScope(task.inputScope, task.workspaceId)
    currentInput = browserInputScope({ sensitivity: maxSensitivity(currentInput.sensitivity, latest.sensitivity),
      compartments: [...currentInput.compartments, ...latest.compartments], projectIds: [...currentInput.projectIds, ...latest.projectIds],
      sources: [...currentInput.sources, ...latest.sources] }, original.workspaceId)
    if (publishingHistory !== null && JSON.stringify(currentInput) !== publishingHistory) return null
    return frozen.ceiling
  })
  await lease.assertCurrent()
  return {
    taskId: original.taskId,
    assertCurrent: () => lease.assertCurrent(),
    async writeBytes(file: BrowserDownload) {
      return runWithAgentAccess(frozen.ceiling, () => runWithAuthorityLease(lease, () => lease.execute(async () => {
        const assistant = await findAssistantById(frozen.assistantId)
        if (!assistant || assistant.workspaceId !== original.workspaceId) throw denied()
        const readSource = async (kind: string, id: string): Promise<ScopeSource & {requiredSources?: ScopeSource[]}> => {
          const value = (await queryWithRLS<{ source: (ScopeSource & {requiredSources?: ScopeSource[]}) | null }>(original.userId,
            'SELECT read_entity_derivation_source($1,$2,$3) AS source', [original.workspaceId, kind, id])).rows[0]?.source
          if (!value) throw denied()
          // Project only the typed evidence fields; raw readers may add held/expiry metadata.
          const { workspaceId, resourceKind, resourceId, version, userId, assistantId, sensitivity, compartments, projectIds } = value
          return { workspaceId, resourceKind, resourceId, version, userId, assistantId, sensitivity, compartments, projectIds,
            ...(kind === 'workflow_run' ? {requiredSources:value.requiredSources} : {}) }
        }
        const sources: ScopeSource[] = []
        if (origin.kind === 'session') {
          const sessionSource = await readSource('browser_session', origin.id)
          if (sessionSource.userId !== original.userId || sessionSource.sensitivity !== (origin.effectiveClearance ?? 'public')
            || !sameSet(sessionSource.compartments, origin.contextCompartments)
            || !sameSet(sessionSource.projectIds, origin.contextProjectId ? [origin.contextProjectId] : [])) throw denied()
          sources.push(sessionSource)
        } else if (origin.kind === 'workflow') {
          const {requiredSources,...workflowSource} = await readSource('workflow_run', origin.runId)
          if (!Array.isArray(requiredSources)) throw denied()
          const parents = requiredSources.map(({workspaceId,resourceKind,resourceId,version,userId,assistantId,sensitivity,compartments,projectIds}) =>
            ({workspaceId,resourceKind,resourceId,version,userId,assistantId,sensitivity,compartments,projectIds}))
          sources.push(...browserInputScope({sources:[workflowSource,...parents]},original.workspaceId).sources)
        } else throw denied()
        if (original.profileId) {
          const floor = BrowserProfileAuthoritySchema.safeParse(original.profileAuthority)
          if (!floor.success || floor.data.id !== original.profileId || floor.data.workspaceId !== original.workspaceId) throw denied()
          const profile = await readSource('browser_profile', original.profileId)
          if (profile.userId !== (floor.data.scope === 'owner' ? floor.data.ownerUserId : null)
            || profile.sensitivity !== floor.data.clearance
            || !sameSet(profile.compartments, floor.data.departmentId ? [`team:${floor.data.departmentId}`] : [])) throw denied()
          // Even a shared profile's original owner is an independent retained floor.
          const row = (await queryWithRLS<{ owner_user_id: string }>(original.userId,
            'SELECT owner_user_id FROM browser_profiles WHERE id=$1 AND workspace_id=$2', [original.profileId, original.workspaceId])).rows[0]
          if (row?.owner_user_id !== floor.data.ownerUserId) throw denied()
          sources.push(profile)
        } else if (original.profileAuthority) throw denied()
        await lease.assertCurrent()
        publishingHistory = JSON.stringify(currentInput)
        const evidence = browserInputScope({ ...currentInput, sensitivity: maxSensitivity(currentInput.sensitivity, frozen.ceiling.clearance),
          sources: [...currentInput.sources, ...sources] }, original.workspaceId)
        const derivation = { producer: file.origin ?? 'browser-download', sources: evidence.sources }
        const scope = deriveResourceScope(derivation, { workspaceId: original.workspaceId, userId: null, assistantId: null,
          sensitivity: evidence.sensitivity, compartments: evidence.compartments, projectIds: evidence.projectIds })
        const ctx: FilesContext = { ...frozen.ceiling, assistantId: frozen.assistantId, assistantKind: assistant.kind,
          derivation, writeSensitivity: scope.sensitivity, writeCompartments: scope.compartments, writeProjectIds: scope.projectIds }
        const stamp = createHash('sha256').update(JSON.stringify([original.taskId, scope, derivation])).digest('hex')
        const name = file.name.replace(/[^\w.-]+/g, '_') || 'download'
        const content = createHash('sha256').update(file.path).update(file.bytes).digest('hex')
        const path = `/${file.origin === 'compute-artifact' ? 'computer/artifacts' : 'browser-downloads'}/${stamp}/${content}/${name}`
        // The installed ambient lease also renews between the blob write and row admission.
        const saved = await withPublication({ ...original, inputScope: currentInput }, () =>
          api.writeBytes(ctx, { path, bytes: file.bytes, mime: file.mime, title: file.name, sensitivity: scope.sensitivity }))
        if (saved.ok) return saved.value
        if (saved.error.kind === 'conflict') {
          const read = await api.readBytes(ctx, path)
          if (read.ok && read.value.file.createdByUserId === original.userId && read.value.file.createdByAssistantId === frozen.assistantId
            && read.value.file.userId === scope.userId && read.value.file.assistantId === scope.assistantId
            && read.value.file.sensitivity === scope.sensitivity && sameSet(read.value.file.compartments, scope.compartments)
            && sameSet(read.value.file.projectIds, scope.projectIds) && Buffer.from(read.value.bytes).equals(Buffer.from(file.bytes))) return read.value.file
        }
        throw new Error('Could not persist browser download (authorization, quota, or conflict).')
      })))
    },
  }
}
