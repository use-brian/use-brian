/** Opt-in cross-repo test; run scripts/project-harness/smoke-linked-task.sh. */
import assert from 'node:assert/strict'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import { createExecutionContext, executionToolContext } from '@use-brian/agent-runtime/security/execution-context.js'
import type { ToolContext } from '@use-brian/agent-runtime/tools/types.js'
// Import the checkout, not a potentially stale @use-brian/core/dist.
import { createTaskTools } from '../../core/src/tasks/tools.js'
import { briefFixture } from '../src/briefs/__tests__/fixture.js'
import { createAuthorityLease } from '../src/context-scope/authority-lease.js'
import { getAppPool, getPool } from '../src/db/client.js'
import { createTask, resolveTaskById } from '../src/db/tasks.js'
import { createDbTaskStore } from '../src/db/tasks-store.js'
import { createExternalProgressTools } from '../src/tasks/external-progress.js'
import { buildWorkspaceMcpCatalog } from '../src/workspace-mcp/catalog.js'

const { assertLocalFixture } = await import(new URL('../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

async function brianFixture() {
  const { workspaceId, people, assistants } = await briefFixture()
  const userId = people.lead, assistantId = assistants.brian, credentialId = randomUUID()
  const task = await createTask(userId, { workspaceId, title: 'Linked coding smoke' })
  const access = { userId, assistantId, workspaceId, assistantKind: 'standard' as const, clearance: 'internal' as const,
    compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: [assistantId] }
  const authority = createAuthorityLease(access, async () => access)
  const ec = createExecutionContext({ access, authority, ownership: { kind: 'workspace', workspaceId },
    identity: { kind: 'programmatic', principal: { kind: 'brain_key', credentialId, actorUserId: userId }, credentialOwnerUserId: userId },
    writeDefaults: { compartments: [], projectIds: [] }, lifecycle: { sessionId: randomUUID(), sessionPersisted: false,
      channelType: 'assistant_mcp', channelId: credentialId, abortSignal: new AbortController().signal } })
  const context: ToolContext = { ...executionToolContext(ec, { appId: 'Use Brian' }), programmaticPrincipal: { kind: 'brain_key', userId, credentialId },
    activeCapabilities: new Set(['tasks', 'home_app:tasks:write']), scopeAccumulator: new ContextScopeAccumulator() }
  const tools = new Map(Object.entries({ ...createExternalProgressTools(), updateTask: createTaskTools(createDbTaskStore()).updateTask }))
  const catalog = await buildWorkspaceMcpCatalog(async () => ({ context, tools, operationNames: new Set(tools.keys()), readOnly: false }))

  return { workspaceId, credentialId, access, task, catalog }
}

async function smoke(work: string) {
  const { workspaceId, credentialId, access, task, catalog } = await brianFixture()
  const bearer = randomUUID(), calls: string[] = [], states: string[] = []
  let finished = false, failure: unknown
  let acknowledgeStart!: () => void
  const startReturned = new Promise<void>(resolve => { acknowledgeStart = resolve })
  const callback = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/mcp')
      assert.ok(req.headers.authorization === `Bearer ${bearer}`, 'Invalid fixture bearer')
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const rpc = JSON.parse(Buffer.concat(chunks).toString())
      assert.equal(rpc.method, 'tools/call')
      const { name, arguments: input } = rpc.params
      calls.push(name)
      const tool = catalog.find(t => t.name === name)
      assert.ok(tool, `Unexpected callback (no list/read allowed): ${name}`)
      // If new_task_with_context waits on Brian's callback, the initiating request times out.
      if (name === 'bindExternalTaskExecution') await startReturned
      if (name === 'reportTaskProgress') states.push(input.state)
      if (name === 'updateTask') assert.deepEqual(input, { id: task.id, coding_state: states.at(-1) })
      const result = await tool.handler(input)
      assert.equal(result.structuredContent?.status, 'succeeded', JSON.stringify(result))
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
      if (name === 'updateTask' && input.coding_state === 'claimed_done') finished = true
    } catch (err) { failure ??= err; res.writeHead(400).end() }
  })
  callback.listen(0, '127.0.0.1'); await once(callback, 'listening')
  const child = spawn(join(work, 'sidanCode'), [], { cwd: work, env: {
    HOME: work, PATH: process.env.PATH, SIDAN_ADDR: '127.0.0.1:0', SIDAN_PROJECTS_DIR: work,
    CODEX_BIN: fileURLToPath(new URL('../../../scripts/project-harness/smoke-linked-task-codex.mjs', import.meta.url)),
    SIDAN_BRIAN_TASK_MCP_URL: `http://127.0.0.1:${(callback.address() as AddressInfo).port}/mcp`, SIDAN_BRIAN_TASK_TOKEN: bearer,
  }, stdio: ['ignore', 'ignore', 'pipe'] })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  child.on('error', err => { failure ??= err })
  let logs = ''
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-8192) })
  async function until(ok: () => boolean, label: string) {
    const deadline = Date.now() + 20000
    while (!ok()) {
      if (failure) throw failure
      assert.ok(child.exitCode === null && Date.now() < deadline, `${label}; calls=${calls}; ${logs}`)
      await sleep(25)
    }
  }
  try {
    const listener = /sidanCode listening on (127\.0\.0\.1:\d+)/
    await until(() => listener.test(logs), 'waiting for Go listener')
    const res = await fetch(`http://${logs.match(listener)![1]}/mcp`, { method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'new_task_with_context', arguments: { prompt: 'Implement the fixture', context: { summary: 'Contract smoke' }, brianTaskId: task.id },
      } }) })
    const rpc = await res.json()
    if (failure) throw failure
    assert.ok(res.ok, `Go MCP returned HTTP ${res.status}`)
    const { result } = z.object({ jsonrpc: z.literal('2.0'), id: z.literal(1), result: z.object({
      content: z.array(z.object({ text: z.string() })).nonempty(), isError: z.boolean().optional(),
    }) }).parse(rpc)
    assert.ok(!result.isError, result.content[0].text)
    const session = JSON.parse(result.content[0].text)
    assert.equal(session.brianTaskId, task.id)
    acknowledgeStart()
    await until(() => finished, 'waiting for terminal board write')
    const head = await resolveTaskById(access, task.id)
    assert.equal(head?.status, 'done')
    const lanes = await getPool().query(`SELECT id, external_execution_id, harness, checkpoint
      FROM task_execution_states WHERE workspace_id=$1 AND task_id=$2 AND lane='external'`, [workspaceId, head.id])
    assert.equal(lanes.rowCount, 1)
    const lane = lanes.rows[0]
    assert.ok(session.id); assert.equal(lane.external_execution_id, session.id)
    assert.equal(lane.harness, 'codex'); assert.equal(lane.checkpoint?.milestone, 'completed')
    assert.equal(lane.checkpoint?.reportedState, 'claimed_done')
    const receipts = await getPool().query(`SELECT DISTINCT actor_kind, actor_id, origin FROM task_execution_commands
      WHERE state_id=$1 AND kind IN ('bind','report')`, [lane.id])
    assert.deepEqual(receipts.rows, [{ actor_kind: 'credential', actor_id: credentialId, origin: 'mcp' }])
    if (failure) throw failure
    assert.equal(states[0], 'running'); assert.equal(states.at(-1), 'claimed_done')
    assert.deepEqual(calls, ['bindExternalTaskExecution', ...states.flatMap(() => ['reportTaskProgress', 'updateTask'])])
    console.log(`PASS: start returned before bind acknowledgement; ${calls.join(' → ')}; board done`)
  } finally {
    acknowledgeStart()
    child.kill('SIGTERM'); await closed
    await new Promise<void>(resolve => callback.close(() => resolve()))
  }
}
try { await smoke(process.argv[2]) } finally { await getAppPool().end(); await getPool().end() }
