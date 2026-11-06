/** Internal native chat transport; never an authenticated human request. [COMP:api/workspace-mcp] */
import { z } from 'zod'
import type { ToolContext } from '@use-brian/core'
import type { WorkspaceMcpConsent } from './consent.js'

export type WorkspaceTurnInput = {
  message: string
  fileIds?: string[]
  workspaceFileIds?: string[]
  attachedRecordingIds?: string[]
  model?: string
  mode?: 'default' | 'research'
}
export type WorkspaceTurnBinding = { context: ToolContext; consent: WorkspaceMcpConsent; abortSignal?: AbortSignal;
  onAwaitingApproval?: (approvalId: string, kind: 'question' | 'tool') => void }
export type NativeChatRequest = {
  body: Record<string, unknown>
  userId?: string
  authSessionId?: string
  authVersion?: number
  clientTimezone?: string
}
export type NativeChatSink = {
  readonly writableEnded: boolean
  status(code: number): NativeChatSink
  json(value: unknown): unknown
  setHeader(name: string, value: string): unknown
  flushHeaders(): void
  write(chunk: string): unknown
  end(): unknown
  on(event: string, listener: () => void): unknown
}
export type WorkspaceTurnResult = { status: 'succeeded' | 'failed' | 'waiting_approval' | 'waiting_input'; messageIds: string[]; approvalIds?: string[]; questionIds?: string[]; errorCode?: string; research?: Array<{activityId:string;status:'saved'|'partial'|'failed';saveError:string|null}> }

/** Deliberately discards every streamed text/reasoning/tool payload. */
export function createWorkspaceTurnSink() {
  let ended = false, status = 200, failed = false
  const messageIds = new Set<string>()
  const research=new Map<string,NonNullable<WorkspaceTurnResult['research']>[number]>()
  const sink: NativeChatSink = {
    get writableEnded() { return ended },
    status(code) { status = code; return sink },
    json() { failed = true; ended = true },
    setHeader() {}, flushHeaders() {}, on() {},
    write(chunk) {
      // The native port emits one event per write. No arbitrary text is kept.
      const event = /^event: ([a-z_]+)\ndata: (.*)\n\n$/.exec(chunk)
      if (event?.[1] === 'error') failed = true
      if(event?.[1]==='research_saved'){
        try{
          const value = z.object({ activityId: z.string().uuid(), status: z.enum(['saved', 'partial', 'failed']),
            saveError: z.string().regex(/^[a-z0-9_]{1,80}$/i).nullish(),
          }).parse(JSON.parse(event[2]))
          research.set(value.activityId, { activityId: value.activityId, status: value.status, saveError: value.saveError ?? null })
        }catch{failed=true}
      }
      if (event?.[1] === 'assistant_message_saved') {
        try {
          const value = JSON.parse(event[2]) as { id?: unknown }
          if (typeof value.id === 'string' && /^[a-f0-9-]{36}$/i.test(value.id)) messageIds.add(value.id)
        } catch { failed = true }
      }
    },
    end() { ended = true },
  }
  return { sink, result: (): WorkspaceTurnResult => ({ status: failed || status >= 400 || !messageIds.size ? 'failed' : 'succeeded', messageIds: [...messageIds],...(research.size?{research:[...research.values()]}:{}),
    ...(failed || status >= 400 || !messageIds.size ? { errorCode: 'native_turn_failed' } : {}) }) }
}
