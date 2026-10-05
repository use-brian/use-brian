import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('../db/client.js', () => ({ query: vi.fn() }))
import { query } from '../db/client.js'
import { NativeComputerService } from './service.js'
import { createNativeComputerReadinessOptions, nativeReadiness, safeReadinessUrl } from './readiness.js'
const scope = { userId:'user', workspaceId:'workspace', assistantId:'assistant', conversationId:'conversation', taskId:'task' }
const service = () => new NativeComputerService({ relayUrl:'https://relay.example', relaySecret:'private', jwtSecret:'private', deploymentId:'test' })
beforeEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals() })
function dbReady() {
  vi.mocked(query).mockImplementation(async (sql) => {
    expect(sql.trim()).toMatch(/^SELECT /)
    if (sql.includes('public._migrations')) return { rows:[{},{}] } as never
    if (sql.includes('FROM auth_sessions') || sql.includes('FROM sessions s')) return { rows:[{}] } as never
    return { rows:[] } as never
  })
}
it('refuses unsafe endpoints', () => {
  for (const url of ['http://remote.example','https://user:password@example.com','https://example.com?secret=1']) expect(() => safeReadinessUrl(url)).toThrow()
  expect(safeReadinessUrl('http://127.0.0.1:8080').hostname).toBe('127.0.0.1')
})
it.each([' ', 'x'.repeat(257)])('rejects unusable deployment identity before any I/O', async deploymentId => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const s = new NativeComputerService({ relayUrl: 'https://relay.example', relaySecret: 'private', jwtSecret: 'private', deploymentId })
  expect(await s.readiness(scope, 'auth', 'device')).toEqual(['configuration_invalid'])
  expect(query).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
})
it('uses only SELECT and bounded authenticated nonredirecting relay readiness', async () => {
  dbReady(); const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ enabled:true, protocol:'native-computer-v1' })))
  vi.stubGlobal('fetch', fetch)
  expect(await service().readiness(scope,'auth','device')).toEqual([])
  expect(fetch).toHaveBeenCalledWith('https://relay.example/internal/native-computer/readiness',expect.objectContaining({ redirect:'error', signal:expect.any(AbortSignal), headers:{'x-relay-secret':'private'} }))
})
it('schema and auth failures stop before relay and disclose no errors', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch',fetch)
  vi.mocked(query).mockRejectedValueOnce(new Error('secret SQL'))
  expect(await service().readiness(scope,'auth','device')).toEqual(['schema_unavailable'])
  dbReady()
  vi.mocked(query).mockResolvedValueOnce({rows:[{},{}]} as never).mockResolvedValueOnce({rows:[]} as never).mockResolvedValueOnce({rows:[]} as never)
  expect(await service().readiness(scope,'auth','device')).toEqual(['auth_session_denied'])
  expect(fetch).not.toHaveBeenCalled()
})
it('scope, policy and busy fences do not dispatch or reconcile', async () => {
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch)
  dbReady();const s=service();vi.spyOn(s,'authorized').mockResolvedValue(false)
  expect(await s.readiness(scope,'auth','device')).toEqual(['scope_denied'])
  vi.mocked(s.authorized).mockResolvedValue(true);vi.spyOn(s,'assertPolicy').mockRejectedValue(new Error('private'))
  expect(await s.readiness(scope,'auth','device')).toEqual(['policy_denied'])
  vi.mocked(s.assertPolicy).mockResolvedValue();
  vi.mocked(query).mockResolvedValueOnce({rows:[{},{}]} as never).mockResolvedValueOnce({rows:[]} as never).mockResolvedValueOnce({rows:[{}]} as never).mockResolvedValueOnce({rows:[{}]} as never)
  expect(await s.readiness(scope,'auth','device')).toEqual(['device_busy'])
  expect(fetch).not.toHaveBeenCalled()
})
it('refuses disabled, oversized and unexpected relay responses', async () => {
  dbReady(); const fetch=vi.fn();vi.stubGlobal('fetch',fetch)
  for (const [body, code] of [[JSON.stringify({enabled:false,protocol:'native-computer-v1'}),'relay_disabled'],['x'.repeat(1025),'relay_unavailable'],[JSON.stringify({enabled:true,protocol:'native-computer-v1',secret:'private'}),'relay_unavailable']]) {
    fetch.mockResolvedValueOnce(new Response(body));expect(await service().readiness(scope,'auth','device')).toEqual([code])
  }
})
it('unwired boot cannot report ready; never resolves a model for denied scope', async () => {
  const s=service();vi.spyOn(s,'readiness').mockResolvedValue([])
  expect((await nativeReadiness(s,scope,'auth','device')).blockers).toEqual(['accounting_unavailable','runtime_not_checked'])
  const checkModel=vi.fn().mockResolvedValue({blockers:[],warnings:['vision_budget_insufficient']})
  const options={accountingAvailable:true,checkModel}
  const report=await nativeReadiness(s,scope,'auth','device',options)
  expect(report.ready).toBe(true);expect(report.warnings).toContain('vision_budget_insufficient')
  vi.mocked(s.readiness).mockResolvedValue(['scope_denied']);checkModel.mockClear()
  expect((await nativeReadiness(s,scope,'auth','device',options)).ready).toBe(false);expect(checkModel).not.toHaveBeenCalled()
})
it('sanitizes runtime exceptions and rejects arbitrary callback reason text', async () => {
  const s=service();vi.spyOn(s,'readiness').mockResolvedValue([])
  for (const checkModel of [vi.fn().mockRejectedValue(new Error('secret')),vi.fn().mockResolvedValue(['secret'])]) {
    expect((await nativeReadiness(s,scope,'auth','device',{accountingAvailable:true,checkModel})).blockers).toEqual(['check_failed'])
  }
})

it('production boot shares the runtime options and actual accounting at the authenticated readiness mount', async () => {
  const { readFile } = await import('node:fs/promises')
  const boot = await readFile(new URL('../boot.ts', import.meta.url), 'utf8')
  expect(boot).toContain('createNativeComputerBootRuntimeFactory(nativeModelOptions)')
  expect(boot).toContain('createNativeComputerReadinessOptions(nativeAccounting, nativeModelOptions, !!ports.nativeComputerRuntimeFactory)')
  expect(boot).toContain("nativeComputerAuth(env.JWT_SECRET), nativeComputerRoutes(nativeComputerService, nativeDiagnosticTool, nativeComputerReadiness, nativeContextTaskStore)")
  expect(boot).not.toContain("allTools.set('nativeComputerTask'")
  expect(boot).toContain('composeComputerProfileTools(nativeComputerService, createProfileImagePolicy({ ...nativeModelOptions, managedRoutes: nativeImageManagedRoutes }), nativeAccounting ? createProfileImageAccounting(nativeComputerService, nativeAccounting) : undefined)')
  expect(boot).toContain('imageApproval: { accepted: visionAccepted, model: visionModel }')
})

function configuredReadiness() {
  const provider = { name: 'routing', models: ['claude-sonnet-4-6'], stream: vi.fn(), createSession: vi.fn() }
  const custom = { provider, selector: 'claude-sonnet-4-6', routeKind: 'managed' as const, profileId: null, modelTier: 'standard' as const,
    fallback: { enabled: false, used: false, reason: null, status: null, detail: null, endpointName: 'private' },
    inputTokenLimit: 32768, maxTokens: 2048, supportsVision: true, providerKeySource: 'platform' as const }
  const options = { provider, configuredProviders: new Set(['gemini', 'anthropic', 'openai-codex']), getWorkspacePlan: vi.fn(async () => 'enterprise'),
    resolveWorkspaceCustomLlm: vi.fn(async () => custom), decisionRuntime: { resolveRoute: vi.fn(async () => ({mode:'llm_only' as const})), run:vi.fn() },
    budget: { tokens:10000000, costUsd:1000, attemptTokens:32768, attemptCostUsd:3.2768 },
    imageApproval: { accepted:true, model:'claude-sonnet-4-6' } }
  const accounting = { backend:'oss-native-v1' as const, admit:vi.fn(), prepare:vi.fn(), reconcile:vi.fn(), reconcileBatch:vi.fn() }
  return { provider, custom, options, accounting }
}

it.each(['ready','no-image','custom-image','mismatch','unaccepted','missing-pin','token-budget','cost-budget','codex','codex-wrapper'] as const)(
  'production readiness reports precise %s metadata with no model calls, reservations or accounting', async scenario => {
    const f=configuredReadiness(), s=service();vi.spyOn(s,'readiness').mockResolvedValue([])
    if(scenario==='no-image') f.custom.supportsVision=false
    if(scenario==='custom-image') Object.assign(f.custom,{routeKind:'custom',selector:'custom:00000000-0000-4000-8000-000000000000'})
    if(scenario==='mismatch') f.options.imageApproval.model='different-private-model'
    if(scenario==='unaccepted') f.options.imageApproval.accepted=false
    if(scenario==='missing-pin') f.options.imageApproval.model=''
    if(scenario==='token-budget') f.options.budget.tokens=1000000
    if(scenario==='cost-budget') f.options.budget.costUsd=30
    if(scenario==='codex') f.provider.name='openai-codex'
    if(scenario==='codex-wrapper') { f.custom.selector='gpt-5.6-luna';f.provider.models=['gpt-5.6-luna'] }
    const report=await nativeReadiness(s,scope,'auth','device',createNativeComputerReadinessOptions(f.accounting,f.options))
    expect(report.ready).toBe(!scenario.startsWith('codex'))
    expect(report.blockers).toEqual(scenario.startsWith('codex')?['provider_unsupported']:[])
    expect(report.warnings).toContain('native_strict_adapter_unverified')
    expect(report.warnings.includes('vision_image_unsupported')).toBe(['no-image','custom-image','codex','codex-wrapper'].includes(scenario))
    expect(report.warnings.includes('vision_approval_mismatch')).toBe(['mismatch','custom-image','codex-wrapper'].includes(scenario))
    expect(report.warnings.includes('vision_approval_unaccepted')).toBe(['unaccepted','missing-pin'].includes(scenario))
    expect(report.warnings.includes('vision_budget_insufficient')).toBe(['token-budget','cost-budget'].includes(scenario))
    expect(report.warnings).not.toContain('vision_not_checked')
    expect(f.options.getWorkspacePlan).toHaveBeenCalledTimes(1)
    expect(f.options.resolveWorkspaceCustomLlm).toHaveBeenCalledTimes(1)
    expect(f.options.decisionRuntime.resolveRoute).toHaveBeenCalledTimes(2)
    expect(f.options.decisionRuntime.run).not.toHaveBeenCalled()
    expect(f.provider.stream).not.toHaveBeenCalled();expect(f.provider.createSession).not.toHaveBeenCalled()
    for(const method of ['admit','prepare','reconcile','reconcileBatch'] as const) expect(f.accounting[method]).not.toHaveBeenCalled()
    expect(JSON.stringify(report)).not.toMatch(/private|gpt-|claude-|custom:/)
  })
it('does not resolve models for missing accounting or an opaque runtime override', async () => {
  const f=configuredReadiness(), s=service();vi.spyOn(s,'readiness').mockResolvedValue([])
  const missing=await nativeReadiness(s,scope,'auth','device',createNativeComputerReadinessOptions(undefined,f.options))
  expect(missing.blockers).toEqual(['accounting_unavailable'])
  const override=await nativeReadiness(s,scope,'auth','device',createNativeComputerReadinessOptions(f.accounting,f.options,true))
  expect(override.blockers).toEqual(['runtime_not_checked'])
  expect(override.warnings).toContain('vision_not_checked')
  expect(f.options.resolveWorkspaceCustomLlm).not.toHaveBeenCalled()
  expect(f.options.getWorkspacePlan).not.toHaveBeenCalled()
})

it.each([false, true])('serves production inspection metadata without grant/model calls (backend-only=%s)', async backendOnly => {
  const { default: express } = await import('express')
  const { default: request } = await import('supertest')
  const { nativeComputerRoutes } = await import('../routes/native-computer.js')
  const f=configuredReadiness(), s=service(), id='00000000-0000-4000-8000-000000000000'
  vi.spyOn(s,'readiness').mockResolvedValue([])
  const create=vi.spyOn(s,'create'), dispatch=vi.spyOn(s,'dispatch'), run=vi.spyOn(s,'run')
  const a=express();a.use(express.json());a.use((req,_res,next)=>{req.userId='authenticated';req.authSessionId='current-auth';next()})
  a.use('/api/native-computer',nativeComputerRoutes(s,undefined,createNativeComputerReadinessOptions(f.accounting,f.options)))
  const response=await request(a).post('/api/native-computer/readiness').send({workspaceId:id,assistantId:id,conversationId:id,taskId:id,...(backendOnly ? {backendOnly:true} : {deviceId:'device'})})
  expect(response.status).toBe(200)
  expect(response.headers['cache-control']).toBe('no-store')
  expect(s.readiness).toHaveBeenCalledWith(expect.objectContaining({workspaceId:id,taskId:id}), 'current-auth', backendOnly ? undefined : 'device')
  expect(response.body).toEqual({protocol:'native-computer-v1',ready:!backendOnly,blockers:backendOnly ? ['device_not_checked'] : [],warnings:[
    'jwt_compatibility_unverified','live_model_unverified','mac_verification_pending','native_strict_adapter_unverified']})
  expect(f.options.resolveWorkspaceCustomLlm).toHaveBeenCalledTimes(1)
  expect(f.options.resolveWorkspaceCustomLlm).toHaveBeenCalledWith(expect.objectContaining({workspaceId:id,allowFailureFallback:false}))
  expect(create).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled()
  expect(f.provider.stream).not.toHaveBeenCalled();expect(f.provider.createSession).not.toHaveBeenCalled()
  expect(f.accounting.admit).not.toHaveBeenCalled();expect(f.accounting.prepare).not.toHaveBeenCalled();expect(f.accounting.reconcile).not.toHaveBeenCalled()
})

it('denies another-device conversation lease using the exact global partial-index predicate', async () => {
  dbReady()
  const previous = vi.mocked(query).getMockImplementation()!
  vi.mocked(query).mockImplementation(async (sql, params) => {
    if (sql.includes('WHERE user_id=$1 AND conversation_id=$2')) {
      expect(sql).toMatch(/WHERE user_id=\$1 AND conversation_id=\$2 AND revoked_at IS NULL LIMIT 1/)
      expect(sql).not.toMatch(/device_id|deployment_id|expires_at/)
      expect(params).toEqual([scope.userId,scope.conversationId])
      // Existing nonrevoked lease is on another device/deployment; age is irrelevant
      // to the unique index, and preflight must not perform create's expiry cleanup.
      return {rows:[{deviceId:'other-device',deploymentId:'other-deployment'}]} as never
    }
    return previous(sql,params)
  })
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch)
  expect(await service().readiness(scope,'auth','new-device')).toEqual(['device_busy'])
  expect(fetch).not.toHaveBeenCalled()
  expect(vi.mocked(query).mock.calls.every(([sql])=>sql.trim().startsWith('SELECT '))).toBe(true)
})


it('refuses an exact managed Anthropic route when only Gemini is configured', async () => {
  const f = configuredReadiness(), s = service()
  vi.spyOn(s, 'readiness').mockResolvedValue([])
  f.options.configuredProviders = new Set(['gemini'])
  const report = await nativeReadiness(s, scope, 'auth', 'device', createNativeComputerReadinessOptions(f.accounting, f.options))
  expect(report.ready).toBe(false)
  expect(report.blockers).toEqual(['model_unavailable'])
  expect(f.provider.stream).not.toHaveBeenCalled()
  expect(f.provider.createSession).not.toHaveBeenCalled()
  expect(f.options.decisionRuntime.run).not.toHaveBeenCalled()
  for (const method of ['admit', 'prepare', 'reconcile', 'reconcileBatch'] as const) expect(f.accounting[method]).not.toHaveBeenCalled()
})

it('backend-only checks the backend without inventing a device or reporting ready', async () => {
  dbReady()
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ enabled:true, protocol:'native-computer-v1' })))
  vi.stubGlobal('fetch', fetch)
  const checkModel = vi.fn().mockResolvedValue({ blockers:[], warnings:[] })
  const report = await nativeReadiness(service(), scope, 'auth', undefined, { accountingAvailable:true, checkModel })
  expect(report).toMatchObject({ ready:false, blockers:['device_not_checked'] })
  expect(checkModel).toHaveBeenCalledWith(scope)
  expect(fetch).toHaveBeenCalledTimes(1)
  const sql = vi.mocked(query).mock.calls.map(([sql]) => sql)
  expect(sql.some(sql => sql.includes('public._migrations'))).toBe(true)
  expect(sql.some(sql => sql.includes('FROM auth_sessions'))).toBe(true)
  expect(sql.some(sql => sql.includes('FROM sessions s'))).toBe(true)
  expect(sql.some(sql => sql.includes('mcp_tool_settings'))).toBe(true)
  expect(sql.some(sql => sql.includes('conversation_id=$2 AND revoked_at IS NULL'))).toBe(true)
  expect(sql.some(sql => sql.includes('deployment_id=$1 AND device_id=$2'))).toBe(false)
})

it('backend-only retains the conversation fence and still inspects relay and model configuration', async () => {
  dbReady()
  const original = vi.mocked(query).getMockImplementation()!
  vi.mocked(query).mockImplementation((...args) => args[0].includes('conversation_id=$2 AND revoked_at IS NULL')
    ? Promise.resolve({ rows:[{}] } as never) : original(...args))
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ enabled:false, protocol:'native-computer-v1' })))
  vi.stubGlobal('fetch', fetch)
  const checkModel = vi.fn().mockResolvedValue({ blockers:['model_unavailable'], warnings:[] })
  const report = await nativeReadiness(service(), scope, 'auth', undefined, { accountingAvailable:true, checkModel })
  expect(report).toMatchObject({ ready:false, blockers:['device_busy','relay_disabled','model_unavailable','device_not_checked'] })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(checkModel).toHaveBeenCalledTimes(1)
})

it.each(['schema_unavailable','auth_session_denied','scope_denied','policy_denied'] as const)(
  'backend-only preserves %s admission and always discloses missing device checks', async code => {
    const s = service(); vi.spyOn(s, 'readiness').mockResolvedValue([code])
    const checkModel = vi.fn()
    expect(await nativeReadiness(s, scope, 'auth', undefined, { accountingAvailable:true, checkModel }))
      .toMatchObject({ ready:false, blockers:[code,'device_not_checked'] })
    expect(checkModel).not.toHaveBeenCalled()
  })

it('backend-only cannot hide missing service/accounting configuration', async () => {
  const checkModel = vi.fn()
  expect(await nativeReadiness(null, scope, 'auth', undefined, { accountingAvailable:false, checkModel }))
    .toMatchObject({ ready:false, blockers:['native_disabled','accounting_unavailable','device_not_checked'] })
  expect(checkModel).not.toHaveBeenCalled()
})

it('readiness schema accepts only exclusive full or explicit backend-only contexts', async () => {
  const { ReadinessContextSchema } = await import('./readiness.js')
  const id='00000000-0000-4000-8000-000000000000'
  const context={workspaceId:id,assistantId:id,conversationId:id,taskId:id}
  expect(ReadinessContextSchema.safeParse({...context,deviceId:'device'}).success).toBe(true)
  expect(ReadinessContextSchema.safeParse({...context,backendOnly:true}).success).toBe(true)
  for (const body of [context,{...context,backendOnly:false},{...context,backendOnly:'true'},
    {...context,backendOnly:true,deviceId:'device'},{...context,backendOnly:true,deviceId:null},
    {...context,backendOnly:true,taskId:undefined},{...context,backendOnly:true,extra:true}]) {
    expect(ReadinessContextSchema.safeParse(body).success).toBe(false)
  }
})
