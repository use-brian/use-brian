/**
 * P1.7 end-to-end through the real tool executor: the terminal LinkedIn-DM
 * send (a click on a "Send"-labeled ref) PAUSES at the confirmation gate and
 * executes only on approve — deny means the click never reaches the browser.
 * On durable channel paths the same gate persists a `pending_approvals`
 * `kind='tool_invocation'` row via `context.createToolInvocationApproval`
 * (WU-6.3); this test drives the in-memory resolver the chat route wires.
 */
import { describe, it, expect } from 'vitest'
import { createToolExecutor } from '../../engine/tool-executor.js'
import { createLoopDetector } from '../../engine/loop-detector.js'
import { createConfirmationResolver } from '../../mcp/types.js'
import type { ContentBlock } from '../../providers/types.js'
import type { Tool, ToolContext } from '../../tools/types.js'
import { createComputerTools } from '../tools.js'
import type { BrowserProvider } from '../types.js'

function recordingProvider(): BrowserProvider & { clicks: string[] } {
  const clicks: string[] = []
  return {
    kind: 'local',
    clicks,
    async navigate(_ctx, url) {
      return { url }
    },
    async snapshot() {
      return {
        url: 'https://www.linkedin.com/messaging/thread/123/',
        title: 'Jane Doe | Messaging',
        nodes: [
          { ref: '@e1', role: 'textbox', name: 'Write a message' },
          { ref: '@e2', role: 'button', name: 'Send' },
        ],
      }
    },
    async click(_ctx, ref) {
      clicks.push(ref)
    },
    async type() {},
    async currentUrl() {
      return { url: 'https://www.linkedin.com/messaging/thread/123/', title: 'Jane Doe | Messaging' }
    },
    async stop() {},
  }
}

const ctx: ToolContext = {
  userId: 'u',
  assistantId: 'a',
  sessionId: 's',
  appId: 'sidanclaw',
  channelType: 'web',
  channelId: 'c',
  workspaceId: 'w',
  abortSignal: new AbortController().signal,
}

async function drain(executor: ReturnType<typeof createToolExecutor>): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = []
  for await (const batch of executor.getRemainingResults()) {
    blocks.push(...batch.blocks)
  }
  return blocks
}

function setup() {
  const provider = recordingProvider()
  const computer = createComputerTools({ local: provider, cloud: provider })
  const tools = new Map<string, Tool>([
    ['browserNavigate', computer.browserNavigate],
    ['browserSnapshot', computer.browserSnapshot],
    ['browserClick', computer.browserClick],
    ['browserType', computer.browserType],
    ['browserCurrentUrl', computer.browserCurrentUrl],
  ])
  const resolver = createConfirmationResolver()
  const confirmations: string[] = []
  const executor = createToolExecutor({
    tools,
    context: ctx,
    loopDetector: createLoopDetector(),
    confirmationResolver: resolver,
    confirmationTimeoutMs: 60_000,
    onConfirmationRequired: (req) => void confirmations.push(req.toolCallId),
  })
  return { provider, executor, resolver, confirmations }
}

describe('[COMP:sandbox/browser-tools] Terminal send is approval-gated (P1.7)', () => {
  it('pauses the Send click at the gate and executes it only on approve', async () => {
    const { provider, executor, resolver, confirmations } = setup()

    // Compose: snapshot caches labels; typing needs no approval.
    executor.addTool('t1', 'browserSnapshot', {})
    executor.addTool('t2', 'browserType', { ref: '@e1', text: 'Hey Jane!' })
    await drain(executor)
    expect(confirmations).toEqual([])

    // The terminal send: a click on the "Send"-labeled ref. The gate is
    // dynamic (resolveConfirmation is async), so give it a microtask to fire.
    executor.addTool('t3', 'browserClick', { ref: '@e2' })
    await new Promise((r) => setTimeout(r, 0))
    expect(confirmations).toEqual(['t3']) // gate fired before any execution
    expect(provider.clicks).toEqual([]) // and the browser has NOT been touched

    const drained = (async () => drain(executor))()
    resolver.resolve('t3', 'allow')
    const blocks = await drained

    expect(provider.clicks).toEqual(['@e2']) // approved → the click ran
    const result = blocks.find((b) => (b as { toolUseId?: string }).toolUseId === 't3') as {
      content?: unknown
      isError?: boolean
    }
    expect(result?.isError ?? false).toBe(false)
  })

  it('deny means the click never reaches the browser', async () => {
    const { provider, executor, resolver } = setup()
    executor.addTool('t1', 'browserSnapshot', {})
    await drain(executor)

    executor.addTool('t2', 'browserClick', { ref: '@e2' })
    const drained = (async () => drain(executor))()
    resolver.resolve('t2', 'deny')
    const blocks = await drained

    expect(provider.clicks).toEqual([])
    const result = blocks.find((b) => (b as { toolUseId?: string }).toolUseId === 't2') as {
      isError?: boolean
    }
    expect(result?.isError).toBe(true)
  })

  it('a composing click (person link) sails through with no gate', async () => {
    const provider = recordingProvider()
    // Add a link node so the composing click has a benign target.
    provider.snapshot = async () => ({
      url: 'https://www.linkedin.com/messaging/',
      title: 'Messaging',
      nodes: [
        { ref: '@e1', role: 'link', name: 'Jane Doe' },
        { ref: '@e2', role: 'button', name: 'Send' },
      ],
    })
    const computer = createComputerTools({ local: provider, cloud: provider })
    const tools = new Map<string, Tool>([
      ['browserNavigate', computer.browserNavigate],
      ['browserSnapshot', computer.browserSnapshot],
      ['browserClick', computer.browserClick],
    ])
    const confirmations: string[] = []
    const executor = createToolExecutor({
      tools,
      context: ctx,
      loopDetector: createLoopDetector(),
      confirmationResolver: createConfirmationResolver(),
      confirmationTimeoutMs: 1_000,
      onConfirmationRequired: (req) => void confirmations.push(req.toolCallId),
    })
    executor.addTool('t1', 'browserSnapshot', {})
    await drain(executor)
    executor.addTool('t2', 'browserClick', { ref: '@e1' })
    await drain(executor)
    expect(confirmations).toEqual([])
    expect(provider.clicks).toEqual(['@e1'])
  })
})
