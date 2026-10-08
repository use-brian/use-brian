import type { RelayCommandTransport, SandboxOrchestrator } from '@use-brian/core'
import type { LocalComputerTaskStore } from '../routes/computer.js'

export type BrowserTaskDiscard = (actor: {
  userId: string; workspaceId: string; sessionId: string
}) => Promise<'discarded' | 'not_active'>

/** Safety-only authority: owning a task permits stopping it, never observing it. */
export function createBrowserTaskDiscard(deps: {
  getWorkspaceRole: (userId: string, workspaceId: string) => Promise<string | null>
  localTasks: LocalComputerTaskStore
  transport: RelayCommandTransport | null
  orchestrator: SandboxOrchestrator | null
}): BrowserTaskDiscard {
  return async actor => {
    const member = async () => Boolean(await deps.getWorkspaceRole(actor.userId, actor.workspaceId))
    if (!(await member())) return 'not_active'
    const owns = (task: { userId: string; workspaceId: string } | null | undefined) =>
      task?.userId === actor.userId && task.workspaceId === actor.workspaceId
    const local = deps.localTasks.getActiveBySession(actor.sessionId)
    const cloud = await deps.orchestrator?.getActiveTask(actor.sessionId)
    let discarded = false
    let failed = false
    if (local && owns(local)) {
      try {
        if (!(await member()) || !local.profileId || !deps.transport) throw new Error()
        const current = deps.localTasks.getActiveBySession(actor.sessionId)
        if (current?.taskId === local.taskId) {
          const result = await deps.transport.send({ userId: actor.userId, browserProfileId: local.profileId,
            taskId: local.taskId, op: 'stop', args: {} })
          if (!result.ok || typeof result.data !== 'object' || result.data === null
            || (result.data as { stopped?: unknown }).stopped !== true) throw new Error()
          deps.localTasks.complete(actor.sessionId, local.taskId)
          discarded = true
        }
      } catch { failed = true }
    }
    if (cloud && owns(cloud)) {
      try {
        if (!(await member())) throw new Error()
        discarded = await deps.orchestrator!.discardTask(actor.sessionId, cloud.taskId) || discarded
      } catch { failed = true }
    }
    if (failed) throw new Error('Browser discard could not be confirmed.')
    return discarded ? 'discarded' : 'not_active'
  }
}
