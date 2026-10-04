import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
vi.mock('../../db/client.js', () => ({ query: vi.fn() }))
import { query } from '../../db/client.js'
import { NativeComputerService } from '../service.js'
import { composeNativeComputerTool } from '../composition.js'
import { createNativeComputerModelRuntimeFactory } from '../model-runtime.js'
import type { LLMProvider, ProviderRequest } from '@use-brian/core'
import type { NativeCommand, NativeGrant, NativeObservation, NativeStatus } from '@use-brian/computer-control/protocol.js'

afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })

it.each(['complete', 'missing-version', 'stale-completion', 'dropped-cohort', 'handoff', 'unknown'] as const)(
  'real service/provider/model transport preserves visual authority: %s', async scenario => {
    const protocol = 'native-computer-v1' as const
    const scope = { userId: 'u', workspaceId: 'w', assistantId: 'a', conversationId: 'c', taskId: 't' }
    const identity = { ...scope, deploymentId: 'd', deviceId: 'dev', sessionId: 's' }
    // Wire identity deliberately excludes assistant metadata.
    const { assistantId: _assistant, ...wireIdentity } = identity
    const target = { appId: 'com.usebrian.NativeComputerFixture', processId: 1, processInstanceId: 'p', windowId: 'win', windowInstanceId: 'wi' }
    const grant: NativeGrant = { protocol, identity: wireIdentity, grantId: 'g', epoch: 1, expiresAt: Date.now() + 60_000,
      targets: [target], allowControl: true, allowCapture: true, requester: 'User', goal: 'Activate the outlined triangle; finish when Result is Triangle.' }
    const verifier = 'v'.repeat(43)
    const row = { ...scope, id: 's', deviceId: 'dev', deploymentId: 'd', challenge: createHash('sha256').update(verifier).digest('base64url'),
      epoch: 1, state: 'active', expiresAt: new Date(grant.expiresAt), grantId: 'g', authSessionId: 'auth', runState: null as string | null }
    vi.mocked(query).mockImplementation(async sql => {
      const text = String(sql)
      if (text.includes("SET run_state='running'")) {
        if (row.runState) return { rows: [] } as never
        row.runState = 'running'
      }
      return { rows: text.includes('SELECT id,user_id') ? [{ ...row }] : text.includes('mcp_tool_settings') ? [] : [{ id: 's' }] } as never
    })
    const status: NativeStatus = { protocol, identity: wireIdentity, state: 'active', epoch: 1, expiresAt: grant.expiresAt,
      capabilities: { protocol, platform: 'darwin', axRead: true, semanticActions: true, windowCapture: true, input: false,
        ...(scenario === 'missing-version' ? {} : { visualInvokeVersion: 1 as const }), accessibilityPermission: 'granted', capturePermission: 'granted', limitations: [] } }
    let seq = 0, invoked = false, baseline: NativeObservation | undefined
    const observation = (): NativeObservation => ({ identity: wireIdentity, target, epoch: 1, id: `o${++seq}`,
      capturedAt: Date.now(), monotonicMs: seq, foreground: true, completeness: 'complete', captureCohort: 'public-shapes-v1',
      bounds: { x: 0, y: 0, width: 100, height: 100 }, displayLayoutVersion: 'l',
      nodes: [{ ref: `r${seq}`, role: 'AXStaticText', name: 'Result', value: invoked ? 'Triangle' : 'None', enabled: true, focused: false, selected: false, sensitive: false, actions: [] }] })
    const commands: NativeCommand[] = [], urls: string[] = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
      urls.push(String(url))
      if (init?.method === 'DELETE' || String(url).endsWith('/register')) return Response.json({ ok: true })
      if (!String(url).endsWith('/command')) return Response.json({ active: true, status })
      const command = JSON.parse(init!.body as string) as NativeCommand
      commands.push(command)
      if (command.action.kind === 'visualInvoke') {
        invoked = true
        return Response.json({ commandId: command.commandId, outcome: scenario === 'unknown' ? 'execution_unknown' : 'executed', code: 'ok' })
      }
      let o = observation()
      if (!baseline) baseline = o
      if (invoked && scenario === 'stale-completion') o = { ...baseline, nodes: o.nodes }
      if (invoked && scenario === 'dropped-cohort') delete o.captureCohort
      if (command.action.kind === 'capture') o.frame = { id: 'frame', width: 100, height: 100, mimeType: 'image/png', data: 'cGl4ZWxz', bounds: o.bounds, displayLayoutVersion: 'l' }
      return Response.json({ commandId: command.commandId, outcome: 'executed', code: 'ok', observation: o })
    }))
    const requests: ProviderRequest[] = []
    const model: LLMProvider = { name: 'mock', models: ['test'], createSession: vi.fn(), stream: async function* (request) {
      requests.push(request)
      // Ensure the frozen baseline is strictly older than final AX evidence.
      await new Promise(resolve => setTimeout(resolve, 2))
      if (scenario === 'handoff') status.state = 'paused_for_user'
      yield { type: 'text_delta', text: '{"x":10,"y":20}' }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 },
        nativeMetadata: { actualModel: 'test', usage: { inputTokens: 10, outputTokens: 2 } } }
    } }
    const meter = vi.fn(async () => {})
    const runtime = createNativeComputerModelRuntimeFactory({ localApprovalRequired: true, meter,
      // Explicit test allowance only; production defaults remain untouched.
      budget: { tokens: 10_000_000, costUsd: 1000, attemptTokens: 32768, attemptCostUsd: 1 },
      resolve: async () => ({ provider: model, model: 'test', plan: 'enterprise', budgetStatus: 'ok', grounder: { provider: model, model: 'test', nativeGrounding: true } }) })
    const service = new NativeComputerService({ relayUrl: 'https://relay.invalid', relaySecret: 'synthetic', jwtSecret: 'synthetic', deploymentId: 'd' })
    await service.exchange('s', 'u', verifier, grant)
    const tool = composeNativeComputerTool(service, runtime)
    const result = await service.run('s', 'u', 'auth', tool, new AbortController().signal)
    expect(result).toMatchObject({ data: { outcome: scenario === 'complete' ? 'completed' : scenario === 'unknown' ? 'execution_unknown' : 'paused' } })
    expect(commands.map(c => c.action.kind)).toEqual(scenario === 'missing-version' ? ['observe', 'observe']
      : scenario === 'handoff' ? ['observe', 'observe', 'capture']
      : ['observe', 'observe', 'capture', 'visualInvoke', ...(scenario === 'unknown' ? [] : ['observe'])])
    expect(requests).toHaveLength(scenario === 'missing-version' ? 0 : 1)
    if (requests.length) {
      expect(requests[0]).toMatchObject({ model: 'test', nativeStrict: true, allowProviderFallback: false })
      expect(JSON.stringify(requests[0])).toContain('cGl4ZWxz')
      expect(meter).toHaveBeenCalledTimes(3)
      expect(meter).toHaveBeenLastCalledWith(expect.objectContaining({ lane: 'vision', invocationState: 'settled', outcome: 'ok' }))
    }
    expect(urls.every(url => url.startsWith('https://relay.invalid/internal/native-computer'))).toBe(true)
    const count = commands.length
    expect(await service.run('s', 'u', 'auth', tool, new AbortController().signal)).toMatchObject({ duplicate: true })
    expect(commands).toHaveLength(count)
  })
