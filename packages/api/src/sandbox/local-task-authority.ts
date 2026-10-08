/** Local tasks retain original profile, execution and source authority. */
import {
  BrowserProfileAuthoritySchema,
  accessCeilingContains,
  canUseProfile,
  parseAuthoringAuthority,
  type CurrentAuthorityBoundary,
  type BrowserCallContext,
  type BrowserProfileAuthority,
  type BrowserProfileStore,
  type DepartmentReadGrant,
} from '@use-brian/core'
import type { LocalComputerTaskRecord, LocalComputerTaskStore } from '../routes/computer.js'
import { resolveBrowserTaskExecutionAuthority } from './task-execution-authority.js'
import { humanCanReadBrowserProfile } from './profile-authority.js'

const denied = () => Object.assign(new Error('Profile authority unavailable'), { code: 'profile_authority_denied' })
const sameFloor = (left: BrowserProfileAuthority, right: BrowserProfileAuthority) =>
  left.id === right.id && left.workspaceId === right.workspaceId && left.ownerUserId === right.ownerUserId
  && left.scope === right.scope && left.clearance === right.clearance
  && (left.departmentId ?? null) === (right.departmentId ?? null)

/** The live lease remains process-local with the ephemeral tab binding. */
export async function assertLocalTaskExecutionAuthority(task: LocalComputerTaskRecord): Promise<void> {
  if ((task.executionAuthority && !task.authority) || (task.sourceAuthority && !task.executionAuthority)) throw denied()
  await task.authority?.assertCurrent()
}

export function createLocalTaskAdmission(deps: {
  profiles: Pick<BrowserProfileStore, 'get'> | null | undefined
  tasks: LocalComputerTaskStore
  resolveExecutionAuthority?: (...args: Parameters<typeof resolveBrowserTaskExecutionAuthority>) => Promise<CurrentAuthorityBoundary>
  /** Must renew current workspace membership as well as department READ. */
  resolveHumanRead: (userId: string, workspaceId: string) => Promise<DepartmentReadGrant | null>
}): (ctx: BrowserCallContext, op: string) => Promise<(() => Promise<void>) & { taskId?: string }> {
  return async (ctx, op) => {
    try {
      if (!ctx.userId || !ctx.workspaceId || !ctx.profileId || !ctx.sessionId || !deps.profiles) throw denied()
      const { userId, workspaceId, profileId, sessionId } = ctx
      const current = async (): Promise<BrowserProfileAuthority> => {
        const profile = await deps.profiles!.get(profileId)
        if (!profile || profile.id !== profileId || profile.workspaceId !== workspaceId) throw denied()
        const grant = await deps.resolveHumanRead(userId, workspaceId)
        if (!humanCanReadBrowserProfile(profile, userId, grant)
          || (grant && profile.scope === 'workspace' && !profile.departmentId)) throw denied()
        const floor = BrowserProfileAuthoritySchema.parse(profile)
        const latest = BrowserProfileAuthoritySchema.safeParse(await deps.profiles!.get(profileId))
        if (!latest.success || !sameFloor(floor, latest.data)) throw denied()
        return floor
      }
      const retain = async (): Promise<CurrentAuthorityBoundary | undefined> => {
        if (!ctx.executionAuthority) {
          if (ctx.sourceAuthority) throw denied()
          return ctx.authority
        }
        const frozen = parseAuthoringAuthority(ctx.executionAuthority)
        if (!frozen || !ctx.authority) throw denied()
        const original = ctx.authority
        const assertProfile = async () => {
          const profile = await deps.profiles!.get(profileId)
          if (!profile || !sameFloor(BrowserProfileAuthoritySchema.parse(profile), floor) || !canUseProfile(profile, { userId, workspaceId, assistantId: frozen.assistantId,
            assistantClearance: frozen.ceiling.clearance, departmentRead: frozen.ceiling.departmentRead }).ok) throw denied()
        }
        const retained = await (deps.resolveExecutionAuthority ?? resolveBrowserTaskExecutionAuthority)({
          userId, workspaceId, executionAuthority: frozen, sourceAuthority: ctx.sourceAuthority,
        }, original)
        return {
          ...(original.snapshotSource ? { snapshotSource: () => original.snapshotSource!() } : {}),
          async assertCurrent() { await retained.assertCurrent(); await original.assertCurrent(); await assertProfile() },
          async execute<T>(operation: () => Promise<T>): Promise<T> {
            return retained.execute(() => original.execute(async () => {
              await assertProfile()
              const result = await operation()
              await assertProfile()
              return result
            }))
          },
        }
      }
      const floor = await current()
      const existing = deps.tasks.getActiveBySession(sessionId)
      let taskId: string | null = null
      let operationAuthority: CurrentAuthorityBoundary | undefined
      if (existing) {
        const pin = BrowserProfileAuthoritySchema.safeParse(existing.profileAuthority)
        if (existing.userId !== userId || existing.workspaceId !== workspaceId || existing.profileId !== profileId
          || (ctx.taskId && ctx.taskId !== existing.taskId) || !pin.success || !sameFloor(pin.data, floor)) throw denied()
        if (ctx.executionAuthority && (!existing.executionAuthority
          || ctx.executionAuthority.assistantId !== existing.executionAuthority.assistantId
          || !accessCeilingContains(ctx.executionAuthority.ceiling, existing.executionAuthority.ceiling))) throw denied()
        await assertLocalTaskExecutionAuthority(existing)
        if (ctx.inputScope) deps.tasks.noteInputScope(sessionId, existing.taskId, ctx.inputScope)
        taskId = existing.taskId
      } else if (op === 'navigate' || op === 'openTab') {
        // An old explicit task handle cannot create a replacement binding.
        if (ctx.taskId) throw denied()
        operationAuthority = await retain()
        await operationAuthority?.assertCurrent()
        deps.tasks.touch({ userId, workspaceId, sessionId, profileId, profileAuthority: floor,
          executionAuthority: ctx.executionAuthority, sourceAuthority: ctx.sourceAuthority, authority: operationAuthority, inputScope: ctx.inputScope })
        const created = deps.tasks.getActiveBySession(sessionId)
        taskId = created?.taskId ?? null
        if (!taskId || created?.authority !== operationAuthority) throw denied()
      } else if (op !== 'captureState' || floor.ownerUserId !== userId || ctx.taskId) {
        throw denied()
      } else {
        operationAuthority = await retain()
      }
      const renew = async () => {
        try {
          await operationAuthority?.assertCurrent()
          if (!sameFloor(floor, await current())) throw denied()
          const task = deps.tasks.getActiveBySession(sessionId)
          if (taskId) {
            const pin = BrowserProfileAuthoritySchema.safeParse(task?.profileAuthority)
            if (!task || task.taskId !== taskId || task.userId !== userId || task.workspaceId !== workspaceId
              || task.profileId !== profileId || !pin.success || !sameFloor(pin.data, floor)) throw denied()
            await assertLocalTaskExecutionAuthority(task)
          } else if (task) {
            // Explicit capture was admitted without a task; do not return a different binding's state.
            throw denied()
          }
        } catch { throw denied() }
      }
      // Profile lookup and membership resolution can await independently. Close that
      // admission window before dispatch, and again after the relay response.
      await renew()
      return Object.assign(renew, taskId ? { taskId } : {})
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'browser_publication_busy') throw error
      throw denied()
    }
  }
}
