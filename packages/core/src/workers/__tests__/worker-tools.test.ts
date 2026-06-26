import { describe, it, expect } from 'vitest'
import { createWorkerTools } from '../tools.js'
import type { WorkerManager, WorkerStatus, WorkerResult } from '../worker.js'

type FakeManager = WorkerManager & {
  spawned: Array<{ prompt: string; description?: string }>
  stopped: string[]
  __setCompleted: (id: string, result: string) => void
}

function makeFakeManager(options?: { cap?: number | null }): FakeManager {
  const spawned: Array<{ prompt: string; description?: string }> = []
  const stopped: string[] = []
  const results = new Map<string, string>()
  const statuses = new Map<string, WorkerStatus>()
  let counter = 0
  let cap: number | null = options?.cap ?? null
  function active(): number {
    let n = 0
    for (const s of statuses.values()) if (s === 'running') n++
    return n
  }
  return {
    spawned,
    stopped,
    spawn(prompt: string, _context: unknown, _requestTools?: unknown, description?: string) {
      if (cap !== null && active() >= cap) return null
      const workerId = `worker_${++counter}`
      spawned.push({ prompt, description })
      statuses.set(workerId, 'running')
      return { workerId }
    },
    setMaxConcurrent(n: number | null) {
      cap = n
    },
    get maxConcurrent(): number | null { return cap },
    get activeCount(): number { return active() },
    stop(workerId: string): boolean {
      stopped.push(workerId)
      if (!statuses.has(workerId)) return false
      statuses.set(workerId, 'stopped')
      return true
    },
    getStatus(workerId: string): WorkerStatus | null {
      return statuses.get(workerId) ?? null
    },
    getResult(workerId: string): string | null {
      return results.get(workerId) ?? null
    },
    get pendingCount(): number { return active() },
    drainNotifications(): WorkerResult[] { return [] },
    async waitForNext(): Promise<void> {},
    async waitAll(): Promise<WorkerResult[]> { return [] },
    formatNotification(result: WorkerResult): string {
      return `<worker-result>\n  <worker-id>${result.workerId}</worker-id>\n  <status>${result.status}</status>\n  <result>${result.result}</result>\n</worker-result>`
    },
    __setCompleted(id: string, result: string) {
      statuses.set(id, 'completed')
      results.set(id, result)
    },
  } as unknown as FakeManager
}

const ctx = {
  assistantId: 'a1',
  userId: 'u1',
  sessionId: 's1',
  appId: 'sidanclaw',
  channelType: 'web',
  channelId: 'c_1',
  abortSignal: new AbortController().signal,
}

describe('[COMP:workers/tools] spawnWorker', () => {
  it('forwards the prompt to the manager and returns immediately (non-blocking)', async () => {
    const manager = makeFakeManager()
    const { spawnWorker } = createWorkerTools(manager)
    const result = await spawnWorker.execute({ description: 'Tokyo ramen roundup', prompt: 'Find the best ramen in Tokyo' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(manager.spawned).toHaveLength(1)
    expect(manager.spawned[0].prompt).toBe('Find the best ramen in Tokyo')
    expect(String(result.data)).toContain('worker_1')
    expect(String(result.data)).toContain('spawned')
  })

  it('passes the caller-supplied description through to the manager', async () => {
    const manager = makeFakeManager()
    const { spawnWorker } = createWorkerTools(manager)
    await spawnWorker.execute({ description: 'Research row 5: Acme Corp', prompt: 'You are a VC researcher. Research Acme Corp.' }, ctx)
    expect(manager.spawned[0].description).toBe('Research row 5: Acme Corp')
  })

  it('truncates an over-length description instead of hard-failing the spawn', () => {
    // Regression — prod incident 2026-06-26, session 2d29043f (Telegram).
    // `description` is a cosmetic UI label. It used to be z.string().max(80),
    // so a research request where the model wrote a 100-char label hard-failed
    // Zod validation ("description: String must contain at most 80
    // character(s)"). Both parallel spawnWorker calls errored, no worker
    // spawned, the coordinator turn went empty, and the channel surfaced the
    // canned "I couldn't generate a reply" banner. The label now truncates so
    // an over-length label never breaks the dispatch. The executor parses tool
    // input via `inputSchema.parse` (tool-executor.ts), which runs the
    // transform — so we assert at the schema layer where the bug lived.
    const { spawnWorker } = createWorkerTools(makeFakeManager())
    const longLabel =
      'Research the key business metrics and growth indicators that VCs prioritize when evaluating scale'
    expect(longLabel.length).toBeGreaterThan(80)
    const parsed = spawnWorker.inputSchema.parse({ description: longLabel, prompt: 'Search the web.' })
    expect(parsed.description).toBe(longLabel.slice(0, 80))
    expect(parsed.description.length).toBe(80)
  })

  it('forwards the truncated label through to the manager (parse → execute)', async () => {
    const manager = makeFakeManager()
    const { spawnWorker } = createWorkerTools(manager)
    const input = spawnWorker.inputSchema.parse({ description: 'A'.repeat(100), prompt: 'task' })
    const result = await spawnWorker.execute(input, ctx)
    expect(result.isError).toBeFalsy()
    expect(manager.spawned[0].description).toBe('A'.repeat(80))
  })

  it('is NOT read-only (workers have side effects)', () => {
    const { spawnWorker } = createWorkerTools(makeFakeManager())
    expect(spawnWorker.isReadOnly).toBe(false)
  })

  it('returns a structured at-capacity error when the manager rejects the spawn', async () => {
    // Concurrency cap: when the manager refuses to spawn (e.g. research mode
    // is at 10/10 active workers), the tool surfaces a structured error
    // tool_result so the model sees clear feedback to stop spawning this
    // turn and let Phase 4b drain. Without this, the model could silently
    // burn budget asking for workers that never started.
    const manager = makeFakeManager({ cap: 2 })
    const { spawnWorker } = createWorkerTools(manager)
    // Fill capacity (2/2).
    const r1 = await spawnWorker.execute({ description: 'w1', prompt: 'task 1' }, ctx)
    const r2 = await spawnWorker.execute({ description: 'w2', prompt: 'task 2' }, ctx)
    expect(r1.isError).toBeFalsy()
    expect(r2.isError).toBeFalsy()
    // Third spawn — rejected.
    const r3 = await spawnWorker.execute({ description: 'w3', prompt: 'task 3' }, ctx)
    expect(r3.isError).toBe(true)
    expect(String(r3.data)).toContain('at capacity')
    expect(String(r3.data)).toContain('2/2')
    expect(String(r3.data)).toContain('next turn')
    // The rejected spawn must NOT count toward `spawned` — only the 2 that succeeded did.
    expect(manager.spawned).toHaveLength(2)
  })
})

describe('[COMP:workers/tools] sendWorkerMessage', () => {
  it('returns an error for unknown worker', async () => {
    const manager = makeFakeManager()
    const { sendWorkerMessage } = createWorkerTools(manager)
    const result = await sendWorkerMessage.execute(
      { workerId: 'worker_missing', message: 'more detail please' },
      ctx,
    )
    expect(result.isError).toBe(true)
  })

  it('returns an error when worker is still running', async () => {
    const manager = makeFakeManager()
    const { spawnWorker, sendWorkerMessage } = createWorkerTools(manager)
    await spawnWorker.execute({ description: 'Research X', prompt: 'Research X' }, ctx)
    const result = await sendWorkerMessage.execute(
      { workerId: 'worker_1', message: 'more detail please' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('running')
  })

  it('returns the cached result when worker is completed', async () => {
    const manager = makeFakeManager()
    const { spawnWorker, sendWorkerMessage } = createWorkerTools(manager)
    await spawnWorker.execute({ description: 'Research X', prompt: 'Research X' }, ctx)
    manager.__setCompleted('worker_1', 'The answer is 42')
    const result = await sendWorkerMessage.execute(
      { workerId: 'worker_1', message: 'tell me more' },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(result.data).toBe('The answer is 42')
  })
})

describe('[COMP:workers/tools] stopWorker', () => {
  it('stops a running worker and returns success', async () => {
    const manager = makeFakeManager()
    const { spawnWorker, stopWorker } = createWorkerTools(manager)
    await spawnWorker.execute({ description: 'Research X', prompt: 'Research X' }, ctx)
    const result = await stopWorker.execute({ workerId: 'worker_1' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(manager.stopped).toContain('worker_1')
  })

  it('returns an error for unknown worker', async () => {
    const manager = makeFakeManager()
    const { stopWorker } = createWorkerTools(manager)
    const result = await stopWorker.execute({ workerId: 'worker_ghost' }, ctx)
    expect(result.isError).toBe(true)
  })
})
