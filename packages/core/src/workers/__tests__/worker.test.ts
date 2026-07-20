import { describe, it, expect } from 'vitest'
import { createWorkerManager } from '../worker.js'
import type { WorkerResult, WorkerUsageEvent } from '../worker.js'
import type { LLMProvider, ProviderSession, SessionOptions, StreamChunk, Message, ProviderRequest } from '../../providers/types.js'

/** Minimal fake provider that yields a single text message. */
function makeFakeProvider(responseText: string): LLMProvider {
  function* chunks(): Generator<StreamChunk> {
    yield { type: 'message_start', model: 'gemini-flash' }
    yield { type: 'text_delta', text: responseText }
    yield {
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: responseText.length },
    }
  }
  return {
    name: 'fake',
    models: ['gemini-flash'],
    async *stream(_req: ProviderRequest) { yield* chunks() },
    createSession(): ProviderSession {
      return {
        send(_messages: Message[]): AsyncIterable<StreamChunk> {
          return (async function* () { yield* chunks() })()
        },
      }
    },
  }
}

function makeThrowingProvider(): LLMProvider {
  return {
    name: 'fake',
    models: ['gemini-flash'],
    async *stream(_req: ProviderRequest) { throw new Error('provider down') },
    createSession(): ProviderSession {
      return {
        send(_messages: Message[]): AsyncIterable<StreamChunk> {
          return (async function* () {
            throw new Error('provider down')
          })()
        },
      }
    },
  }
}

const ctx = {
  assistantId: 'a1',
  userId: 'u1',
  sessionId: 's1',
  appId: 'Use Brian',
  channelType: 'web' as const,
  channelId: 'c1',
  abortSignal: new AbortController().signal,
}

describe('[COMP:workers/manager] createWorkerManager', () => {
  it('spawn() returns a worker id and notification arrives when complete', async () => {
    const manager = createWorkerManager({
      provider: makeFakeProvider('The answer is 42'),
      model: 'gemini-flash',
      tools: new Map(),
    })
    const { workerId } = manager.spawn('What is the answer?', ctx)!
    expect(workerId).toBe('worker_1')
    // Wait for the worker to complete via the notification queue
    await manager.waitForNext()
    const notifications = manager.drainNotifications()
    expect(notifications).toHaveLength(1)
    expect(notifications[0].status).toBe('completed')
    expect(notifications[0].result).toBe('The answer is 42')
    expect(notifications[0].workerId).toBe('worker_1')
  })

  it('surfaces an empty-output worker as failed, not a "No results found" completion (incident 2026-07-08 run 12abd640)', async () => {
    // A worker that produced ZERO synthesis text must NOT masquerade as a
    // completed "No results found." finding — that made an internal empty turn
    // indistinguishable from a genuine negative result, so the coordinator read
    // it as "nothing exists" and the parent consult failed `empty_response`.
    const manager = createWorkerManager({
      provider: makeFakeProvider(''),
      model: 'gemini-flash',
      tools: new Map(),
    })
    manager.spawn('Find 5 new HKTV Mall merchants', ctx)
    await manager.waitForNext()
    const [n] = manager.drainNotifications()
    expect(n.status).toBe('failed')
    expect(n.result).not.toContain('No results found')
    expect(n.result).toContain('EMPTY')
    expect(n.result).toContain('worker_empty_output')
  })

  it('scopes notification delivery by spawning session — never delivers to another session (incident 2026-06-02)', async () => {
    // The manager is a process-wide singleton shared across every user/channel.
    // A worker spawned by session A must NOT surface in session B's turn — that
    // bled one user's research into another user's chat (cross-tenant leak).
    const manager = createWorkerManager({
      provider: makeFakeProvider('Top 10 IPs: Chiikawa, Labubu, Jellycat'),
      model: 'gemini-flash',
      tools: new Map(),
    })
    const ctxA = { ...ctx, sessionId: 'sess-A', userId: 'anson' }
    manager.spawn('research HK 18-24 IPs', ctxA)
    await manager.waitForNext('sess-A')

    // Session B (a different user's turn on the same singleton) sees nothing.
    expect(manager.hasNotificationsFor('sess-B')).toBe(false)
    expect(manager.pendingCountFor('sess-B')).toBe(0)
    expect(manager.drainNotifications('sess-B')).toHaveLength(0)

    // B's scoped drain did NOT consume A's result — it's still queued for A.
    expect(manager.hasNotificationsFor('sess-A')).toBe(true)
    const a = manager.drainNotifications('sess-A')
    expect(a).toHaveLength(1)
    expect(a[0].ownerSessionId).toBe('sess-A')
    expect(a[0].result).toContain('Chiikawa')
  })

  it('snapshots the onEvent sink per-spawn — a later setOnEvent does not redirect a running worker\'s events (incident sibling)', async () => {
    const manager = createWorkerManager({ provider: makeFakeProvider('x'), model: 'gemini-flash', tools: new Map() })
    const aEvents: string[] = []
    const bEvents: string[] = []
    manager.setOnEvent(() => { aEvents.push('a') })
    manager.spawn('do A', { ...ctx, sessionId: 'sess-A' })
    // A concurrent turn B rebinds the singleton's handler AFTER A's worker spawned.
    manager.setOnEvent(() => { bEvents.push('b') })
    await manager.waitForNext('sess-A')
    // A's worker forwarded to A's captured sink, never B's.
    expect(aEvents.length).toBeGreaterThan(0)
    expect(bEvents).toHaveLength(0)
  })

  it('forwards a worker run\'s accumulated usage to onUsage with the spawn billing identity', async () => {
    const usages: WorkerUsageEvent[] = []
    const manager = createWorkerManager({
      provider: makeFakeProvider('done'),
      model: 'gemini-flash',
      tools: new Map(),
      onUsage: (u) => usages.push(u),
    })
    manager.spawn('research X', ctx)
    await manager.waitForNext()
    expect(usages).toHaveLength(1)
    expect(usages[0]).toMatchObject({
      workerId: 'worker_1',
      userId: 'u1',
      assistantId: 'a1',
      sessionId: 's1',
      model: 'gemini-flash',
    })
    // Accumulated provider usage flows through unchanged (the fake yields 10 in / N out).
    expect(usages[0].usage.inputTokens).toBe(10)
    expect(usages[0].usage.outputTokens).toBe('done'.length)
  })

  it('records worker_runs under the spawning context, not a concurrently-changed persistence target', async () => {
    const spawns: Array<{ sessionId: string; workspaceId: string }> = []
    const fakeStore = {
      recordSpawn: async (p: { sessionId: string; workspaceId: string }) => { spawns.push({ sessionId: p.sessionId, workspaceId: p.workspaceId }) },
      recordTurn: async () => {},
      recordCompletion: async () => {},
      loadForSession: async () => [],
      deleteTerminalOlderThan: async () => 0,
    }
    const manager = createWorkerManager({ provider: makeFakeProvider('x'), model: 'gemini-flash', tools: new Map() })
    manager.setPersistence({ store: fakeStore as never, sessionId: 'sess-A', workspaceId: 'ws-A' })
    manager.spawn('do A', { ...ctx, sessionId: 'sess-A', workspaceId: 'ws-A' } as never)
    // Concurrent turn B changes the module persistence target after A spawned.
    manager.setPersistence({ store: fakeStore as never, sessionId: 'sess-B', workspaceId: 'ws-B' })
    await manager.waitForNext('sess-A')
    expect(spawns.length).toBeGreaterThan(0)
    expect(spawns[0]).toEqual({ sessionId: 'sess-A', workspaceId: 'ws-A' })
  })

  it('getStatus() tracks a worker through its lifecycle', async () => {
    const manager = createWorkerManager({
      provider: makeFakeProvider('done'),
      model: 'gemini-flash',
      tools: new Map(),
    })
    const { workerId } = manager.spawn('do thing', ctx)!
    expect(manager.getStatus(workerId)).toBe('running')
    await manager.waitForNext()
    expect(manager.getStatus(workerId)).toBe('completed')
  })

  it('getStatus() returns null for unknown worker ids', () => {
    const manager = createWorkerManager({
      provider: makeFakeProvider(''),
      model: 'gemini-flash',
      tools: new Map(),
    })
    expect(manager.getStatus('worker_never_spawned')).toBeNull()
  })

  it('getResult() returns the completed result string', async () => {
    const manager = createWorkerManager({
      provider: makeFakeProvider('result text'),
      model: 'gemini-flash',
      tools: new Map(),
    })
    const { workerId } = manager.spawn('do thing', ctx)!
    await manager.waitForNext()
    expect(manager.getResult(workerId)).toBe('result text')
  })

  it('increments worker id counter across multiple spawns', () => {
    const manager = createWorkerManager({
      provider: makeFakeProvider('x'),
      model: 'gemini-flash',
      tools: new Map(),
    })
    const { workerId: id1 } = manager.spawn('a', ctx)!
    const { workerId: id2 } = manager.spawn('b', ctx)!
    expect(id1).toBe('worker_1')
    expect(id2).toBe('worker_2')
  })

  it('stop() on an unknown worker returns false', () => {
    const manager = createWorkerManager({
      provider: makeFakeProvider(''),
      model: 'gemini-flash',
      tools: new Map(),
    })
    expect(manager.stop('worker_ghost')).toBe(false)
  })

  it('pendingCount tracks running workers', async () => {
    const manager = createWorkerManager({
      provider: makeFakeProvider('done'),
      model: 'gemini-flash',
      tools: new Map(),
    })
    expect(manager.pendingCount).toBe(0)
    manager.spawn('task 1', ctx)
    expect(manager.pendingCount).toBe(1)
    manager.spawn('task 2', ctx)
    expect(manager.pendingCount).toBe(2)
    await manager.waitAll()
    expect(manager.pendingCount).toBe(0)
  })

  it('drainNotifications() clears the queue after returning', async () => {
    const manager = createWorkerManager({
      provider: makeFakeProvider('result'),
      model: 'gemini-flash',
      tools: new Map(),
    })
    manager.spawn('task', ctx)
    await manager.waitForNext()
    const first = manager.drainNotifications()
    expect(first).toHaveLength(1)
    const second = manager.drainNotifications()
    expect(second).toHaveLength(0)
  })

  it('waitForNext() resolves immediately when notifications are already queued', async () => {
    const manager = createWorkerManager({
      provider: makeFakeProvider('fast'),
      model: 'gemini-flash',
      tools: new Map(),
    })
    manager.spawn('task', ctx)
    await manager.waitAll() // ensure worker completes
    // Notifications are queued — waitForNext should resolve immediately
    await manager.waitForNext()
    expect(manager.drainNotifications()).toHaveLength(1)
  })

  it('waitForNext() resolves immediately when no workers are pending', async () => {
    const manager = createWorkerManager({
      provider: makeFakeProvider(''),
      model: 'gemini-flash',
      tools: new Map(),
    })
    // No workers spawned — should resolve immediately
    await manager.waitForNext()
    expect(manager.drainNotifications()).toHaveLength(0)
  })

  it('setResearchMode swaps the worker system prompt to the loosened research variant', async () => {
    // Workers run stateless, so the loop calls provider.stream() directly
    // (not createSession) — spy on stream() to capture the system prompt
    // and the user-message content for research-mode preamble verification.
    const seenPrompts: string[] = []
    const seenUserMessages: string[] = []
    const provider: LLMProvider = {
      name: 'fake',
      models: ['gemini-flash'],
      async *stream(req: ProviderRequest) {
        seenPrompts.push(req.systemPrompt)
        const lastMsg = req.messages[req.messages.length - 1]
        const content = lastMsg?.content
        if (typeof content === 'string') {
          seenUserMessages.push(content)
        } else if (Array.isArray(content)) {
          seenUserMessages.push(
            content
              .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
              .map((b) => b.text)
              .join(''),
          )
        }
        yield { type: 'message_start', model: 'gemini-flash' }
        yield { type: 'text_delta', text: 'ok' }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
      },
      createSession(_opts: SessionOptions): ProviderSession {
        return {
          send(_messages: Message[]): AsyncIterable<StreamChunk> {
            return (async function* () {
              yield { type: 'message_start', model: 'gemini-flash' }
              yield { type: 'text_delta', text: 'ok' }
              yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
            })()
          },
        }
      },
    }

    const manager = createWorkerManager({
      provider,
      model: 'gemini-flash',
      tools: new Map(),
    })

    // Default — constrained prompt, no urlReader nudge, 1-2 search cap.
    // User message is the raw prompt without any RESEARCH MODE preamble.
    manager.spawn('default task', ctx)
    await manager.waitAll()
    expect(seenPrompts).toHaveLength(1)
    expect(seenPrompts[0]).toContain('1-2 web searches maximum')
    expect(seenPrompts[0]).not.toContain('urlReader')
    expect(seenUserMessages[0]).toBe('default task')

    // Research mode on — terse but enforcement-phrased: urlReader required,
    // triangulation, structured XML output. User preamble echoes the
    // protocol so the worker sees it in the user message too.
    manager.setResearchMode(true)
    manager.spawn('research task', ctx)
    await manager.waitAll()
    expect(seenPrompts).toHaveLength(2)
    expect(seenPrompts[1]).toContain('urlReader REQUIRED')
    expect(seenPrompts[1]).toContain('up to 8 searches')
    expect(seenPrompts[1]).toContain('Multi-angle')
    expect(seenPrompts[1]).toContain('Triangulation')
    expect(seenPrompts[1]).toContain('<worker-findings>')
    expect(seenPrompts[1]).toContain('<self-critique>')
    expect(seenPrompts[1]).toContain('<failed-sources>')
    expect(seenPrompts[1]).toContain('Failure codes')
    expect(seenPrompts[1]).not.toContain('1-2 web searches maximum')
    expect(seenUserMessages[1]).toContain('Research protocol')
    expect(seenUserMessages[1]).toContain('Forbidden')
    expect(seenUserMessages[1]).toContain('research task') // original prompt still appended

    // reset() clears the flag — next spawn falls back to constrained
    // prompt and an unwrapped user message.
    manager.reset()
    manager.spawn('post-reset task', ctx)
    await manager.waitAll()
    expect(seenPrompts).toHaveLength(3)
    expect(seenPrompts[2]).toContain('1-2 web searches maximum')
    expect(seenUserMessages[2]).toBe('post-reset task')
  })

  it('setResearchModel upgrades workers to the coordinator model when research mode is on', async () => {
    // Spy on the model field of each provider.stream() request to verify
    // that research-mode workers ride the coordinator's max-tier model
    // (set via setResearchModel) instead of the boot-time options.model.
    const seenModels: string[] = []
    const provider: LLMProvider = {
      name: 'fake',
      models: ['gemini-flash', 'gemini-pro'],
      async *stream(req: ProviderRequest) {
        seenModels.push(req.model)
        yield { type: 'message_start', model: req.model }
        yield { type: 'text_delta', text: 'ok' }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
      },
      createSession(_opts: SessionOptions): ProviderSession {
        return {
          send(_messages: Message[]): AsyncIterable<StreamChunk> {
            return (async function* () {
              yield { type: 'message_start', model: 'gemini-flash' }
              yield { type: 'text_delta', text: 'ok' }
              yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
            })()
          },
        }
      },
    }

    const manager = createWorkerManager({
      provider,
      model: 'gemini-flash', // boot-time default
      tools: new Map(),
    })

    // Default — uses boot-time model.
    manager.spawn('default task', ctx)
    await manager.waitAll()
    expect(seenModels[0]).toBe('gemini-flash')

    // Research mode on but no model override — still uses boot-time model.
    // Guards against accidental coupling between the two flags.
    manager.setResearchMode(true)
    manager.spawn('research task without model', ctx)
    await manager.waitAll()
    expect(seenModels[1]).toBe('gemini-flash')

    // Research mode on AND model override — uses override.
    manager.setResearchModel('gemini-pro')
    manager.spawn('research task with model', ctx)
    await manager.waitAll()
    expect(seenModels[2]).toBe('gemini-pro')

    // Research model set but research mode off — override is ignored.
    // The chat route only calls setResearchModel when researchMode is true,
    // but defense-in-depth: the gate is `isResearch && researchModel`.
    manager.setResearchMode(false)
    manager.spawn('non-research with leftover model', ctx)
    await manager.waitAll()
    expect(seenModels[3]).toBe('gemini-flash')

    // reset() clears both flags — next spawn falls back to boot-time.
    manager.setResearchMode(true)
    manager.setResearchModel('gemini-pro')
    manager.reset()
    manager.spawn('post-reset task', ctx)
    await manager.waitAll()
    expect(seenModels[4]).toBe('gemini-flash')
  })

  it('returns a graceful failed (not crashed) result when the provider errors inside the stream', async () => {
    const manager = createWorkerManager({
      provider: makeThrowingProvider(),
      model: 'gemini-flash',
      tools: new Map(),
    })
    const { workerId } = manager.spawn('test', ctx)!
    await manager.waitForNext()
    const notifications = manager.drainNotifications()
    expect(notifications).toHaveLength(1)
    // A provider error that produced no text is an empty output, not a
    // trustworthy "nothing found" completion — surfaced as `failed` (but the
    // worker still returns gracefully rather than throwing / crashing).
    expect(notifications[0].status).toBe('failed')
    expect(notifications[0].result).not.toContain('No results found')
    expect(manager.getStatus(workerId)).toBe('failed')
  })

  it('formatNotification truncates long worker results to cap coordinator-session bloat', () => {
    // OOM defense: each <worker-result> notification enters the coordinator's
    // stateful session permanently. Multi-wave research with rich worker XML
    // (~1-3KB each) plus Gemini thought signatures (~100-200KB per turn)
    // drove the api process to 2GB OOM (5/26 22:40 trace). formatNotification
    // hard-caps the body at 2000 chars with a "[...truncated N chars]" tail.
    const manager = createWorkerManager({
      provider: makeFakeProvider(''),
      model: 'gemini-flash',
      tools: new Map(),
    })
    const longResult: WorkerResult = {
      workerId: 'worker_huge',
      description: 'long task',
      status: 'completed',
      result: 'X'.repeat(5000),
    }
    const formatted = manager.formatNotification(longResult)
    expect(formatted).toContain('[...truncated 3000 chars')
    // Bounded above by tag overhead (~150 chars) + 2000 body + truncation note.
    expect(formatted.length).toBeLessThan(2400)
    // Short results pass through untouched.
    const shortResult: WorkerResult = {
      workerId: 'worker_small',
      description: 'short task',
      status: 'completed',
      result: 'concise findings',
    }
    const shortFormatted = manager.formatNotification(shortResult)
    expect(shortFormatted).not.toContain('truncated')
    expect(shortFormatted).toContain('concise findings')
  })

  it('setMaxConcurrent caps concurrent spawns; spawn() returns null when at capacity', async () => {
    // Concurrency cap: research-mode coordinator can fan out broadly but
    // shouldn't blow past the configured ceiling. Tool-level enforcement
    // — spawn() returns null when active >= cap, and the spawnWorker tool
    // surfaces a structured "at capacity" error to the model so it knows
    // to stop spawning this turn and let Phase 4b drain.
    //
    // Provider that hangs forever so workers stay 'running' until aborted
    // — lets us deterministically test the cap without races on completion.
    const provider: LLMProvider = {
      name: 'fake',
      models: ['gemini-flash'],
      async *stream() {
        await new Promise((resolve, reject) => {
          // never resolves; aborted by manager.reset()
          setTimeout(reject, 30_000, new Error('test timeout — should have been aborted'))
        })
        yield { type: 'message_start', model: 'gemini-flash' }
      },
      createSession(): ProviderSession {
        return {
          send(): AsyncIterable<StreamChunk> {
            return (async function* () {
              yield { type: 'message_start', model: 'gemini-flash' }
            })()
          },
        }
      },
    }
    const manager = createWorkerManager({
      provider,
      model: 'gemini-flash',
      tools: new Map(),
    })
    manager.setMaxConcurrent(3)
    const r1 = manager.spawn('a', ctx)
    const r2 = manager.spawn('b', ctx)
    const r3 = manager.spawn('c', ctx)
    expect(r1).not.toBeNull()
    expect(r2).not.toBeNull()
    expect(r3).not.toBeNull()
    expect(manager.activeCount).toBe(3)
    // Fourth spawn at capacity — rejected.
    const r4 = manager.spawn('d', ctx)
    expect(r4).toBeNull()
    expect(manager.activeCount).toBe(3) // unchanged
    expect(manager.maxConcurrent).toBe(3)
    // reset() drops the cap (and aborts the hanging workers).
    manager.reset()
    expect(manager.maxConcurrent).toBeNull()
    expect(manager.activeCount).toBe(0)
  })

  it('research-mode worker that ran webSearch without urlReader is flagged as a protocol violation', async () => {
    // Structural backstop: when a research-mode worker exits after running
    // webSearch without ever calling urlReader, the result is snippet-only
    // (the canonical depth-failure mode). The worker manager overwrites
    // the result with an INVALID payload and flips status to 'failed' so
    // the coordinator's gap-assessment sees a clear failure signal and
    // spawns a follow-up — instead of synthesising "no info" from snippet
    // noise. This is the cheap structural enforcement of the urlReader-is-
    // REQUIRED rule, defending against the model ignoring the prompt.
    // Stateless workers go through provider.stream() per turn. Turn 1: emit a
    // webSearch tool_use (matching the production failure pattern — model
    // searched but skipped urlReader). Turn 2+: emit text and exit. The
    // counter switches behaviour across turns.
    let turn = 0
    const provider: LLMProvider = {
      name: 'fake',
      models: ['gemini-pro'],
      async *stream(_req: ProviderRequest) {
        yield { type: 'message_start', model: 'gemini-pro' }
        if (turn === 0) {
          yield { type: 'tool_use_start', id: 'call_1', name: 'webSearch' }
          yield { type: 'tool_use_delta', id: 'call_1', input: '{"query":"x"}' }
          yield { type: 'tool_use_end', id: 'call_1' }
          yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }
        } else {
          yield { type: 'text_delta', text: 'I found some info from snippets.' }
          yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
        }
        turn++
      },
      createSession(): ProviderSession {
        return {
          send(_messages: Message[]): AsyncIterable<StreamChunk> {
            return (async function* () {
              yield { type: 'message_start', model: 'gemini-pro' }
              yield { type: 'text_delta', text: 'unused' }
              yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
            })()
          },
        }
      },
    }
    // Tool map must include webSearch so the executor will accept the call.
    const webSearch = {
      name: 'webSearch',
      description: 'web search',
      inputSchema: { _def: {} } as never,
      isConcurrencySafe: true,
      isReadOnly: true,
      async execute() { return { data: 'snippet results' } },
    } as never
    const manager = createWorkerManager({
      provider,
      model: 'gemini-pro',
      tools: new Map([['webSearch', webSearch]]),
    })
    manager.setResearchMode(true)
    const { workerId } = manager.spawn('research a topic', ctx)!
    await manager.waitAll()
    const result = manager.getResult(workerId)
    expect(manager.getStatus(workerId)).toBe('failed')
    expect(result).toContain('PROTOCOL VIOLATION')
    expect(result).toContain('worker_skipped_urlreader')
    expect(result).toContain('1 webSearch / 0 urlReader')
    // The notification surfaced the failed status too.
    const notifications = manager.drainNotifications()
    expect(notifications[0].status).toBe('failed')
  })

  describe('research read-browse injection (setResearchBrowseTools)', () => {
    /** Fake provider that records the tool names of every request it sees. */
    function makeToolCapturingProvider(seenToolNames: string[][]): LLMProvider {
      function* chunks(): Generator<StreamChunk> {
        yield { type: 'message_start', model: 'gemini-flash' }
        yield { type: 'text_delta', text: 'done' }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
      }
      return {
        name: 'fake',
        models: ['gemini-flash'],
        async *stream(req: ProviderRequest) {
          seenToolNames.push((req.tools ?? []).map((t) => t.name))
          yield* chunks()
        },
        createSession(): ProviderSession {
          return {
            send(_messages: Message[]): AsyncIterable<StreamChunk> {
              return (async function* () {
                yield* chunks()
              })()
            },
          }
        },
      }
    }

    const readOnlyTool = (name: string) =>
      [
        name,
        {
          name,
          description: name,
          inputSchema: { _def: {} } as never,
          isConcurrencySafe: true,
          isReadOnly: true,
          async execute() {
            return { data: 'ok' }
          },
        } as never,
      ] as const

    it('research workers get the browse tools merged into their map', async () => {
      const seen: string[][] = []
      const manager = createWorkerManager({
        provider: makeToolCapturingProvider(seen),
        model: 'gemini-flash',
        tools: new Map(),
      })
      manager.setResearchBrowseTools(new Map([readOnlyTool('browserReadPage')]))
      manager.setResearchMode(true)
      manager.spawn('dig into a gap', ctx, new Map([readOnlyTool('webSearch'), readOnlyTool('urlReader')]))
      await manager.waitAll()
      expect(seen[0]).toContain('browserReadPage')
      expect(seen[0]).toContain('webSearch')
    })

    it('non-research workers never see the browse tools', async () => {
      const seen: string[][] = []
      const manager = createWorkerManager({
        provider: makeToolCapturingProvider(seen),
        model: 'gemini-flash',
        tools: new Map(),
      })
      manager.setResearchBrowseTools(new Map([readOnlyTool('browserReadPage')]))
      manager.spawn('quick lookup', ctx, new Map([readOnlyTool('webSearch')]))
      await manager.waitAll()
      expect(seen[0]).toContain('webSearch')
      expect(seen[0]).not.toContain('browserReadPage')
    })

    it('the injection survives reset() — it is boot config, not per-request state', async () => {
      const seen: string[][] = []
      const manager = createWorkerManager({
        provider: makeToolCapturingProvider(seen),
        model: 'gemini-flash',
        tools: new Map(),
      })
      manager.setResearchBrowseTools(new Map([readOnlyTool('browserReadPage')]))
      manager.reset()
      manager.setResearchMode(true)
      manager.spawn('dig again', ctx, new Map([readOnlyTool('webSearch')]))
      await manager.waitAll()
      expect(seen[0]).toContain('browserReadPage')
    })

    it('a browserReadPage read satisfies the urlReader-or-die protocol enforcement', async () => {
      // Provider that calls webSearch then browserReadPage, then answers.
      let turn = 0
      const provider: LLMProvider = {
        name: 'fake',
        models: ['gemini-flash'],
        async *stream(_req: ProviderRequest) {
          turn += 1
          yield { type: 'message_start', model: 'gemini-flash' }
          if (turn === 1) {
            yield { type: 'tool_use_start', id: 't1', name: 'webSearch' }
            yield { type: 'tool_use_delta', id: 't1', input: '{"query":"x"}' }
            yield { type: 'tool_use_end', id: 't1' }
            yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }
          } else if (turn === 2) {
            yield { type: 'tool_use_start', id: 't2', name: 'browserReadPage' }
            yield { type: 'tool_use_delta', id: 't2', input: '{"url":"https://a.example/x"}' }
            yield { type: 'tool_use_end', id: 't2' }
            yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }
          } else {
            yield { type: 'text_delta', text: '<worker-findings>real findings</worker-findings>' }
            yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
          }
        },
        createSession(): ProviderSession {
          return {
            send(_messages: Message[]): AsyncIterable<StreamChunk> {
              return (async function* () {
                yield { type: 'message_start', model: 'gemini-flash' }
                yield { type: 'text_delta', text: 'unused' }
                yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
              })()
            },
          }
        },
      }
      const manager = createWorkerManager({ provider, model: 'gemini-flash', tools: new Map() })
      manager.setResearchBrowseTools(new Map([readOnlyTool('browserReadPage')]))
      manager.setResearchMode(true)
      const { workerId } = manager.spawn('read a js-heavy page', ctx, new Map([readOnlyTool('webSearch')]))!
      await manager.waitAll()
      expect(manager.getStatus(workerId)).toBe('completed')
      expect(manager.getResult(workerId)).toContain('real findings')
    })
  })
})
