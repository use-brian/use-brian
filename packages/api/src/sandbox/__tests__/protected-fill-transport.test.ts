import { describe, it, expect, vi } from 'vitest'
import { createProtectedFillService } from '../../../../core/src/sandbox/protected-fill.js'
import { createRelayCommandTransport } from '../relay-transport.js'
const scope = { userId: 'u', workspaceId: 'w', sessionId: 's', taskId: 't', browserProfileId: 'p', destinationOrigin: 'https://example.com' }
function setup(fetchImpl: typeof fetch) {
  const service = createProtectedFillService({ authorize: async () => true, validateSource: async () => true, readSource: async () => 'SECRET_SENTINEL' })
  const transport = createRelayCommandTransport({ relayUrl: 'https://relay.example', relaySecret: 'secret', fetchImpl, protectedFill: service })
  const send = (op: string, args?: Record<string, unknown>) => transport.send({ userId: 'u', browserProfileId: 'p', op, args })
  const issue = async () => {
    const r = await service.create(scope, [{ kind: 'crm', entityId: 'e', field: 'email' }])
    return { ...scope, userId: undefined, items: [{ referenceId: r.references[0]!.referenceId, ref: '@e1' }] }
  }
  return { service, transport, send, issue }
}
const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
async function argsFor(issue: ReturnType<typeof setup>['issue']) { const { userId: _, ...args } = await issue(); return args }
describe('protected fill relay boundary', () => {
  it('blocks every observation/action/skill op and strips raw results after dispatch', async () => {
    const fetcher = vi.fn(async () => response({ ok: true, data: { status: 'filled', filledCount: 1, requiresHumanCompletion: true } }))
    const { send, issue, service } = setup(fetcher)
    expect((await send('browserFillReference', await argsFor(issue))).ok).toBe(true)
    expect(service.isLocked(scope)).toBe(true)
    for (const op of ['snapshot', 'navigate', 'click', 'type', 'currentUrl', 'listTabs', 'captureFrame', 'captureState', 'takeoverInput', 'openTab', 'switchTab', 'closeTab', 'runSkill', 'rawCDP']) {
      expect(await send(op)).toEqual({ ok: false, error: 'Protected fill unavailable', code: 'protected_fill_denied' })
    }
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([
    { ok: false, error: 'SECRET_SENTINEL' },
    { ok: true, data: { status: 'filled', filledCount: 1, requiresHumanCompletion: true, value: 'SECRET_SENTINEL' } },
    { ok: true, data: 'SECRET_SENTINEL' },
  ])('never exposes malicious relay payload %j', async result => {
    const { send, issue, service } = setup(async () => response(result))
    expect(JSON.stringify(await send('browserFillReference', await argsFor(issue)))).not.toContain('SECRET_SENTINEL')
    expect(service.isLocked(scope)).toBe(true)
  })
  it('retains locks on timeout and blocks replay without another fetch', async () => {
    const fetcher = vi.fn(async () => { throw new Error('SECRET_SENTINEL') })
    const { send, issue, service } = setup(fetcher)
    const args = await argsFor(issue)
    expect(JSON.stringify(await send('browserFillReference', args))).not.toContain('SECRET_SENTINEL')
    await send('browserFillReference', args)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(service.isLocked(scope)).toBe(true)
  })
  it('discards in-flight observations even when human cleanup clears the lock before response', async () => {
    let finish!: () => void
    const waiting = new Promise<void>(resolve => { finish = resolve })
    const { send, service, issue } = setup(async () => { await waiting; return response({ ok: true, data: 'SECRET_SENTINEL' }) })
    const args = await argsFor(issue)
    const pending = send('snapshot')
    await service.reserve(scope, args.items)
    await service.complete(scope)
    finish()
    expect(JSON.stringify(await pending)).not.toContain('SECRET_SENTINEL')
  })
  it('fails closed when the feature is disabled', async () => {
    const fetcher = vi.fn()
    const transport = createRelayCommandTransport({ relayUrl: 'https://relay.example', relaySecret: 'secret', fetchImpl: fetcher })
    expect((await transport.send({ userId: 'u', browserProfileId: 'p', op: 'browserFillReference' })).ok).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('acknowledges safety Stop while the protected-fill lock still blocks observations', async () => {
    const { send, issue, service } = setup(async () => response({ ok: true, data: { stopped: true } }))
    const args = await argsFor(issue)
    await service.reserve(scope, args.items)
    expect(await send('stop')).toEqual({ ok: true, data: { stopped: true } })
    expect(service.isLocked(scope)).toBe(true)
    expect(await send('snapshot')).toMatchObject({ ok: false, code: 'protected_fill_denied' })
  })

  it.each([
    { ok: true, data: { stopped: true, page: 'SECRET_SENTINEL' } },
    { ok: true, data: { stopped: false } },
    { ok: true },
    { ok: false, error: 'SECRET_SENTINEL', code: 'SECRET_SENTINEL' },
    null,
  ])('refuses malformed Stop acknowledgements without releasing content: %j', async payload => {
    const { send } = setup(async () => response(payload))
    expect(await send('stop')).toEqual({ ok: false, error: 'Browser Stop could not be confirmed.', code: 'backend_error' })
  })

  it('does not require profile policy lookup or expose fetch failures for safety Stop', async () => {
    const resolveLocalControlMode = vi.fn(async () => { throw new Error('SECRET_SENTINEL') })
    const transport = createRelayCommandTransport({ relayUrl: 'https://relay.example', relaySecret: 'secret', resolveLocalControlMode,
      fetchImpl: async () => { throw new Error('SECRET_SENTINEL') } })
    expect(await transport.send({ userId: 'u', browserProfileId: 'p', taskId: 't', op: 'stop' }))
      .toEqual({ ok: false, error: 'Browser Stop could not be confirmed.', code: 'backend_error' })
    expect(resolveLocalControlMode).not.toHaveBeenCalled()
  })
})


describe('capability revocation before dispatch', () => {
  it('does not reserve or fetch when live eligibility is revoked after reference creation', async () => {
    let eligible = true
    const service = createProtectedFillService({ authorize: async () => eligible, validateSource: async () => true, readSource: async () => 'value' })
    const refs = await service.create(scope, [{ kind: 'crm', entityId: 'e', field: 'email' }])
    eligible = false
    const fetcher = vi.fn()
    const transport = createRelayCommandTransport({ relayUrl: 'https://relay.example', relaySecret: 'secret', protectedFill: service, fetchImpl: fetcher })
    const { userId: _, ...binding } = scope
    expect((await transport.send({ userId: scope.userId, browserProfileId: scope.browserProfileId, op: 'browserFillReference', args: {
      ...binding, items: [{ referenceId: refs.references[0]!.referenceId, ref: '@e1' }],
    } })).ok).toBe(false)
    expect(service.isLocked(scope)).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
