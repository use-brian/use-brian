/** Actual boot consult transport, Workflow executor and durable owner receiving. [COMP:api/inter-assistant-executor] */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import type { LLMProvider, StreamChunk } from '@use-brian/agent-runtime/providers/types.js'
import { advanceWorkflowRun } from '@use-brian/core/workflow/executor.js'
import { registerAssistants } from '../../boot/assistants.register.js'
import { captureAuthoringAuthoritySystem, resolveWorkflowRunScope } from '../../context-scope/workflow-authority.js'
import { getAppPool, getPool } from '../../db/client.js'
import { createDbCapabilityStore } from '../../db/capability-store.js'
import { createConnectionStore } from '../../db/connection-store.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { createOssUsageStore } from '../../db/oss-usage-store.js'
import { createDbWorkflowRunStore, createDbWorkflowStore } from '../../db/workflow-store.js'
import { persistentContextFixture } from '../../application-platform/__tests__/fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe('[COMP:api/inter-assistant-executor] actual workflow and A2A receiving', () => {
  afterAll(async () => { await getAppPool().end(); await getPool().end() })

  it('runs both entrypoints through the booted owner and persists the result and one usage row per lane', async () => {
    const fixture = await persistentContextFixture('confidential')
    const { pool, workspaceId, ownerId, assistantId } = fixture
    try {
      await pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [workspaceId])
      const specialist = randomUUID()
      await pool.query(`INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance)
        VALUES($1,'Fictional receiving assistant',$2,$3,'standard','confidential')`, [specialist, ownerId, workspaceId])
      const expectedText = 'Fictional scoped answer.'
      let providerCalls = 0
      async function* response(): AsyncGenerator<StreamChunk> {
        providerCalls++
        yield { type: 'message_start', model: 'gemini-3.6-flash-pro' }
        yield { type: 'text_delta', text: `Message body:\n${expectedText} (Word count: ~3)` }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } }
      }
      const provider: LLMProvider = { name: 'fictional-receiver', models: [], stream: response,
        createSession: () => ({ send: response }) }
      const workflows = createDbWorkflowStore(), runs = createDbWorkflowRunStore()
      const { consultTransport } = await registerAssistants({
        provider, allTools: new Map(), memoryStore: createDbMemoryStore(), capabilityStore: createDbCapabilityStore(),
        workflowRunStore: runs, connectionStore: createConnectionStore(), usageStore: createOssUsageStore(),
        ports: {}, env: {}, late: {},
      } as Parameters<typeof registerAssistants>[0])
      const caller = await fixture.execution(ownerId)
      const direct = await consultTransport.send({
        target: { workspaceId, assistantId: specialist },
        caller: { workspaceId, assistantId, userId: ownerId, channelType: 'web' },
        callerAccessCeiling: caller.security.ceiling,
        message: { messageId: randomUUID(), role: 'user', parts: [{ kind: 'text', text: 'Fictional A2A request.' }] },
        chain: { path: [assistantId], budget: 2, depth: 0 },
      })
      expect(direct.task.status.state).toBe('completed')
      expect(direct.task.history?.at(-1)?.parts).toEqual([{ kind: 'text', text: expectedText }])
      const authoringAuthority = await captureAuthoringAuthoritySystem({ workspaceId, userId: ownerId, assistantId })
      const workflow = await workflows.create({ workspaceId, userId: ownerId, name: 'Fictional workflow receiving',
        authoringAuthority,
        definition: { startStepId: 'collect', steps: [{ id: 'collect', type: 'assistant_call',
          target: { assistantId: 'primary' }, prompt: 'Return one fictional scoped answer.' }] },
      })
      const run = await runs.createRun({ workspaceId, workflowId: workflow.id, triggeredBy: ownerId, triggerKind: 'event' })
      const outcome = await advanceWorkflowRun({ workflowStore: workflows, runStore: runs, consultTransport,
        resolvePrimary: async () => assistantId, resolveRunScope: resolveWorkflowRunScope, buildToolRegistry: async () => new Map() }, run.id)
      expect(outcome.kind).toBe('completed')
      const completions = (await pool.query<{ assistantId: string; inputRef: string; released: boolean; outputs: unknown[] }>(`
        SELECT c.assistant_id AS "assistantId", c.input_ref AS "inputRef", s.turn_lease_token IS NULL AS released, c.outputs
        FROM native_turn_completions c JOIN sessions s ON s.id=c.session_id
        WHERE c.workspace_id=$1 AND c.lane='callee' AND c.published_reply AND NOT c.stopped`, [workspaceId])).rows
      expect(completions).toHaveLength(2)
      expect(completions).toEqual(expect.arrayContaining([
        expect.objectContaining({ assistantId: specialist, inputRef: expect.any(String), released: true, outputs: [expect.any(Object)] }),
        expect.objectContaining({ assistantId, inputRef: run.id, released: true, outputs: [expect.any(Object)] }),
      ]))
      expect(providerCalls).toBe(2)
      const billed = (await pool.query(`SELECT assistant_id AS "assistantId", input_tokens::integer AS "inputTokens", output_tokens::integer AS "outputTokens"
        FROM oss_usage_tracking WHERE workspace_id=$1`, [workspaceId])).rows
      expect(billed).toHaveLength(2)
      expect(billed).toEqual(expect.arrayContaining([
        { assistantId: specialist, inputTokens: 5, outputTokens: 3 },
        { assistantId, inputTokens: 5, outputTokens: 3 },
      ]))
    } finally { await fixture.cleanup() }
  })
})
