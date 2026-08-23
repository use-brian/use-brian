/**
 * Temporary, channel-neutral authority for one exact provider thread.
 *
 * An active target lets a channel route treat an otherwise unaddressed reply
 * as an interactive turn. It does not itself authorize a task write: task
 * tools separately evaluate the target authority against task_rules.
 *
 * Spec: docs/architecture/brain/ingest-pipeline.md
 *
 * [COMP:brain/realtime-thread-targets]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'

export const REALTIME_THREAD_TARGET_MAX_TIMEOUT_MINUTES = 43_200

export type RealtimeThreadTarget = {
  id: string
  workspaceId: string
  assistantId: string
  channelType: string
  conversationRef: string
  threadRef: string
  taskIds: string[]
  contextText: string | null
  expiresAt: Date
  createdByUserId: string | null
  createdAt: Date
  updatedAt: Date
}

export type SetRealtimeThreadTargetInput = {
  workspaceId: string
  assistantId: string
  channelType: string
  conversationRef: string
  threadRef: string
  taskIds: string[]
  contextText: string | null
  expiresAt: Date
  createdByUserId: string
}

export type RealtimeThreadTargetStore = {
  set(actingUserId: string, input: SetRealtimeThreadTargetInput): Promise<RealtimeThreadTarget>
  list(
    actingUserId: string,
    input: {
      workspaceId: string
      assistantId: string
      channelType?: string
      includeExpired: boolean
    },
  ): Promise<RealtimeThreadTarget[]>
  remove(
    actingUserId: string,
    input: { workspaceId: string; assistantId: string; id: string },
  ): Promise<boolean>
  /** Trusted inbound-route lookup after channel + assistant resolution. */
  findActive(input: {
    workspaceId: string
    assistantId: string
    channelType: string
    conversationRef: string
    threadRef: string
    now?: Date
  }): Promise<RealtimeThreadTarget | null>
}

export type RealtimeThreadAddressingInput = {
  /** Result of the adapter's ordinary DM / mention / explicit-address gate. */
  explicitlyAddressed: boolean
  workspaceId: string | null
  assistantId: string
  channelType: string
  conversationRef: string
  /** Provider root id. A top-level message has no delegated thread scope. */
  threadRef: string | null | undefined
  targetStore?: Pick<RealtimeThreadTargetStore, 'findActive'>
}

/**
 * Shared addressing decision for every channel adapter. Ordinary direct or
 * mentioned turns keep their existing authority. Only an otherwise-unaddressed
 * reply performs the exact, unexpired target lookup.
 */
export async function resolveRealtimeThreadAddressing(
  input: RealtimeThreadAddressingInput,
): Promise<{ accepted: boolean; target: RealtimeThreadTarget | null }> {
  if (input.explicitlyAddressed) return { accepted: true, target: null }
  if (!input.workspaceId || !input.threadRef || !input.targetStore) {
    return { accepted: false, target: null }
  }
  const target = await input.targetStore.findActive({
    workspaceId: input.workspaceId,
    assistantId: input.assistantId,
    channelType: input.channelType.toLowerCase(),
    conversationRef: input.conversationRef,
    threadRef: input.threadRef,
  })
  return { accepted: target !== null, target }
}

function workspaceGate(workspaceId: string | null | undefined): { data: string; isError: true } | null {
  if (workspaceId) return null
  return {
    data: 'Realtime thread targets require a workspace-scoped assistant. Nothing was changed.',
    isError: true,
  }
}

const channelRefShape = z.string().trim().min(1).max(256)
const taskIdShape = z.string().uuid()

export type RealtimeThreadTargetTools = {
  setRealtimeThreadTarget: Tool
  listRealtimeThreadTargets: Tool
  removeRealtimeThreadTarget: Tool
}

export function createRealtimeThreadTargetTools(
  store: RealtimeThreadTargetStore,
  now: () => Date = () => new Date(),
): RealtimeThreadTargetTools {
  const setRealtimeThreadTarget = buildTool({
    name: 'setRealtimeThreadTarget',
    description:
      'Temporarily treat replies in one exact messaging thread as addressed to this assistant, even when the channel normally requires a mention. ' +
      'This is channel-neutral: pass the provider adapter type plus its conversation and root-thread ids. The target expires automatically. ' +
      'Bind exact task ids when replies may maintain existing tasks; the target alone never permits a task change, which also needs a matching task rule. ' +
      'A workflow can use the delivery message id in `vars.__deliveryMsg_<stepId>` as `thread_ref`. One week is `timeout_minutes: 10080`.',
    inputSchema: z.object({
      channel_type: z.string().trim().toLowerCase().min(1).max(64).describe('Adapter type such as slack, discord, or feishu.'),
      conversation_ref: channelRefShape.describe('Provider conversation/channel id used for delivery.'),
      thread_ref: channelRefShape.describe('Stable provider root-message/thread id. For a workflow delivery, use vars.__deliveryMsg_<stepId>.'),
      timeout_minutes: z.number().int().min(1).max(REALTIME_THREAD_TARGET_MAX_TIMEOUT_MINUTES),
      task_ids: z.array(taskIdShape).max(50).optional().describe('Existing task lineage ids this thread may maintain. Omit for conversational context only.'),
      context_text: z.string().trim().min(1).max(20_000).optional().describe('Visible root-message text used to resolve short replies such as "this is done".'),
    }).strict(),
    isConcurrencySafe: false,
    isReadOnly: false,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      const base = now()
      const expiresAt = new Date(base.getTime() + input.timeout_minutes * 60_000)
      const target = await store.set(context.userId, {
        workspaceId: context.workspaceId!,
        assistantId: context.assistantId,
        channelType: input.channel_type,
        conversationRef: input.conversation_ref,
        threadRef: input.thread_ref,
        taskIds: [...new Set(input.task_ids ?? [])],
        contextText: input.context_text ?? null,
        expiresAt,
        createdByUserId: context.userId,
      })
      return { data: target }
    },
  })

  const listRealtimeThreadTargets = buildTool({
    name: 'listRealtimeThreadTargets',
    description:
      'List temporary realtime thread targets for this workspace and assistant, including their provider references, bound task ids, and expiry. Expired targets are hidden unless include_expired is true.',
    inputSchema: z.object({
      channel_type: z.string().trim().toLowerCase().min(1).max(64).optional(),
      include_expired: z.boolean().optional(),
    }).strict(),
    isConcurrencySafe: true,
    isReadOnly: true,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      return {
        data: await store.list(context.userId, {
          workspaceId: context.workspaceId!,
          assistantId: context.assistantId,
          channelType: input.channel_type,
          includeExpired: input.include_expired === true,
        }),
      }
    },
  })

  const removeRealtimeThreadTarget = buildTool({
    name: 'removeRealtimeThreadTarget',
    description: 'Immediately revoke one realtime thread target by id. The channel returns to its normal mention/addressing policy.',
    inputSchema: z.object({ id: z.string().uuid() }).strict(),
    isConcurrencySafe: false,
    isReadOnly: false,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      const removed = await store.remove(context.userId, {
        workspaceId: context.workspaceId!,
        assistantId: context.assistantId,
        id: input.id,
      })
      if (!removed) {
        return { data: `Realtime thread target ${input.id} was not found for this assistant. Nothing was changed.`, isError: true }
      }
      return { data: { removed: input.id } }
    },
  })

  return { setRealtimeThreadTarget, listRealtimeThreadTargets, removeRealtimeThreadTarget }
}
