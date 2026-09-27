import { describe, it, expect, vi } from 'vitest'
import { createProtectedFillService, isProtectedFillOrigin, PROTECTED_FILL_ERROR, type ProtectedFillScope } from '../protected-fill.js'

const scope: ProtectedFillScope = {
  userId: 'user', workspaceId: 'workspace', sessionId: 'session', taskId: 'task',
  browserProfileId: 'profile', destinationOrigin: 'https://example.com',
}
const source = { kind: 'crm', entityId: 'entity', field: 'email' }
function setup() {
  let time = 1000
  const readSource = vi.fn(async () => 'SECRET_SENTINEL')
  const authorize = vi.fn(async () => true)
  const validateSource = vi.fn(async () => true)
  const service = createProtectedFillService({ readSource, authorize, validateSource, now: () => time })
  const issue = async (count = 1) => {
    const result = await service.create(scope, Array.from({ length: count }, () => source))
    expect(JSON.stringify(result)).not.toContain('SECRET_SENTINEL')
    return result.references.map((entry, i) => ({ referenceId: entry.referenceId, ref: `@e${i + 1}` }))
  }
  return { service, readSource, authorize, validateSource, issue, advance: (ms: number) => { time += ms } }
}

describe('protected fill reference authority', () => {
  it('issues metadata only; resolves a whole batch once and holds lock until completion', async () => {
    const { service, issue, readSource, advance } = setup()
    const items = await issue(2)
    expect(readSource).not.toHaveBeenCalled()
    await service.reserve(scope, items)
    expect(service.isLocked(scope)).toBe(true)
    expect(await service.resolve(scope, items)).toEqual({ items: [
      { ref: '@e1', value: 'SECRET_SENTINEL' }, { ref: '@e2', value: 'SECRET_SENTINEL' },
    ] })
    await expect(service.resolve(scope, items)).rejects.toThrow(PROTECTED_FILL_ERROR)
    advance(200_000)
    expect(service.isLocked(scope)).toBe(true)
    await service.complete(scope)
    expect(service.isLocked(scope)).toBe(false)
  })
  it.each(Object.keys(scope) as (keyof ProtectedFillScope)[])('binds %s exactly', async field => {
    const { service, issue, readSource } = setup()
    const items = await issue()
    const other = { ...scope, [field]: field === 'destinationOrigin' ? 'https://other.example.com' : 'other' }
    await expect(service.resolve(other, items)).rejects.toThrow(PROTECTED_FILL_ERROR)
    expect(readSource).not.toHaveBeenCalled()
    expect(service.isLocked(scope)).toBe(false)
  })
  it.each(['http://example.com', 'https://example.com/', 'https://example.com/path', 'https://user:pass@example.com', 'null', 'https://EXAMPLE.com'])('denies noncanonical origin %s', origin => {
    expect(isProtectedFillOrigin(origin)).toBe(false)
  })
  it('expires at the exact deadline', async () => {
    const { service, issue, advance, readSource } = setup()
    const items = await issue()
    advance(120_000)
    await expect(service.resolve(scope, items)).rejects.toThrow(PROTECTED_FILL_ERROR)
    expect(readSource).not.toHaveBeenCalled()
  })
  it('rechecks authorization and source access without echoing source errors', async () => {
    const { service, issue, readSource } = setup()
    const items = await issue(2)
    readSource.mockRejectedValueOnce(new Error('SECRET_SENTINEL'))
    await expect(service.resolve(scope, items)).rejects.toThrow(/^Protected fill unavailable$/)
    expect(service.isLocked(scope)).toBe(true)
    await expect(service.resolve(scope, items)).rejects.toThrow(PROTECTED_FILL_ERROR)
  })
  it('denies revoked permission before source reads', async () => {
    const { service, issue, authorize, readSource } = setup()
    const items = await issue()
    authorize.mockResolvedValue(false)
    await expect(service.resolve(scope, items)).rejects.toThrow(PROTECTED_FILL_ERROR)
    expect(readSource).not.toHaveBeenCalled()
  })
  it('rejects duplicate targets, duplicate handles, and partially invalid batches atomically', async () => {
    const { service, issue, readSource } = setup()
    const items = await issue(2)
    for (const batch of [[items[0]!, items[0]!], [items[0]!, { ...items[1]!, ref: '@e1' }],
      [items[0]!, { ...items[1]!, referenceId: 'x'.repeat(43) }]]) {
      await expect(service.resolve(scope, batch)).rejects.toThrow(PROTECTED_FILL_ERROR)
    }
    expect(readSource).not.toHaveBeenCalled()
    expect((await service.resolve(scope, items)).items).toHaveLength(2)
  })
  it('binds the reserved target refs as well as the handles', async () => {
    const { service, issue, readSource } = setup()
    const items = await issue()
    await service.reserve(scope, items)
    await expect(service.resolve(scope, [{ ...items[0]!, ref: '@e99' }])).rejects.toThrow(PROTECTED_FILL_ERROR)
    expect(readSource).not.toHaveBeenCalled()
    expect(service.isLocked(scope)).toBe(true)
  })
  it('retains lock when human completion cleanup fails', async () => {
    const { service, issue } = setup()
    await service.resolve(scope, await issue())
    await expect(service.complete(scope, async () => { throw new Error('SECRET_SENTINEL') })).rejects.toThrow(/^Protected fill unavailable$/)
    expect(service.isLocked(scope)).toBe(true)
  })
  it('permits authenticated no-op cleanup after authority restart but never retires an unbound task', async () => {
    const retire = vi.fn(async () => {})
    let allowed = true
    const service = createProtectedFillService({ authorize: async () => false,
      authorizeCompletion: async () => allowed, validateSource: async () => false, readSource: async () => '' })
    await service.complete(scope, retire)
    expect(retire).not.toHaveBeenCalled()
    allowed = false
    await expect(service.complete(scope, retire)).rejects.toThrow(PROTECTED_FILL_ERROR)
  })
  it('serializes concurrent attempts, allowing only one disclosure', async () => {
    const { service, issue, readSource } = setup()
    const items = await issue()
    const results = await Promise.allSettled([service.resolve(scope, items), service.resolve(scope, items)])
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected'])
    expect(readSource).toHaveBeenCalledTimes(1)
  })
  it('blocks another batch, creation, wrong-scope completion and dispatch while locked', async () => {
    const { service, issue } = setup()
    const first = await issue()
    const second = await issue()
    await service.reserve(scope, first)
    await expect(service.resolve(scope, second)).rejects.toThrow(PROTECTED_FILL_ERROR)
    await service.resolve(scope, first)
    await expect(service.resolve(scope, second)).rejects.toThrow(PROTECTED_FILL_ERROR)
    await expect(service.create(scope, [source])).rejects.toThrow(PROTECTED_FILL_ERROR)
    await expect(service.reserve(scope, first)).rejects.toThrow(PROTECTED_FILL_ERROR)
    await expect(service.complete({ ...scope, sessionId: 'other' })).rejects.toThrow(PROTECTED_FILL_ERROR)
    await service.complete(scope)
    await expect(service.resolve(scope, second)).rejects.toThrow(PROTECTED_FILL_ERROR)
  })
})

describe('authenticated recovery transaction', () => {
  function recoverySetup() {
    let time = 0
    const readSource = vi.fn(async () => 'SECRET_SENTINEL')
    const authorizeRecovery = vi.fn(async () => true)
    const service = createProtectedFillService({ authorize: async () => true, authorizeRecovery,
      validateSource: async () => true, readSource, now: () => time })
    const issue = async () => (await service.create(scope, [source])).references.map(r => ({ referenceId: r.referenceId, ref: '@e1' }))
    return { service, readSource, authorizeRecovery, issue, advance: () => { time += 120_000 } }
  }
  it('cancels failed delivery only after invalidating every profile reference; late dispatch/resolve deny', async () => {
    const { service, issue, readSource } = recoverySetup()
    const items = await issue()
    const otherBatch = await issue()
    await service.reserve(scope, items)
    const epoch = service.epoch(scope)
    expect(await service.recover(scope)).toEqual({ status: 'cancelled' })
    expect(service.isLocked(scope)).toBe(false)
    expect(service.epoch(scope)).toBeGreaterThan(epoch)
    for (const batch of [items, otherBatch]) {
      await expect(service.resolve(scope, batch)).rejects.toThrow(PROTECTED_FILL_ERROR)
      await expect(service.reserve(scope, batch)).rejects.toThrow(PROTECTED_FILL_ERROR)
    }
    expect(readSource).not.toHaveBeenCalled()
    expect(await service.recover(scope)).toEqual({ status: 'none' })
  })
  it('keeps expired reservations locked until authenticated cancellation invalidates references', async () => {
    const { service, issue, advance, authorizeRecovery } = recoverySetup()
    const items = await issue()
    await service.reserve(scope, items)
    advance()
    expect(service.isLocked(scope)).toBe(true)
    authorizeRecovery.mockResolvedValueOnce(false)
    await expect(service.recover(scope)).rejects.toThrow(PROTECTED_FILL_ERROR)
    expect(service.isLocked(scope)).toBe(true)
    expect(await service.recover(scope)).toEqual({ status: 'cancelled' })
    await expect(service.resolve(scope, items)).rejects.toThrow(PROTECTED_FILL_ERROR)
  })
  it.each(['success', 'failed-read'])('never unlocks started resolution (%s), even after expiry', async outcome => {
    const { service, issue, readSource, advance } = recoverySetup()
    const items = await issue()
    await service.reserve(scope, items)
    if (outcome === 'failed-read') readSource.mockRejectedValueOnce(new Error('SECRET_SENTINEL'))
    await service.resolve(scope, items).catch(() => {})
    advance()
    const { userId: _, ...binding } = scope
    const recovered = await service.recover(scope)
    expect(recovered).toEqual({ status: 'cleanup_required', request: { ...binding, items } })
    expect(JSON.stringify(recovered)).not.toContain('SECRET_SENTINEL')
    expect(service.isLocked(scope)).toBe(true)
  })
  it('serializes recovery behind an in-flight resolution and retains uncertain disclosure', async () => {
    const { service, issue, readSource } = recoverySetup()
    const items = await issue()
    let finish!: () => void
    let reading!: () => void
    const entered = new Promise<void>(resolve => { reading = resolve })
    const waiting = new Promise<void>(resolve => { finish = resolve })
    readSource.mockImplementationOnce(async () => { reading(); await waiting; return 'SECRET_SENTINEL' })
    const pending = service.resolve(scope, items)
    await entered
    const recovery = service.recover(scope)
    finish()
    await pending
    expect((await recovery).status).toBe('cleanup_required')
    expect(service.isLocked(scope)).toBe(true)
  })
  it('cannot recover a different workspace/profile/user reservation', async () => {
    const { service, issue } = recoverySetup()
    await service.reserve(scope, await issue())
    await expect(service.recover({ ...scope, workspaceId: 'other' })).rejects.toThrow(PROTECTED_FILL_ERROR)
    expect(await service.recover({ ...scope, browserProfileId: 'other' })).toEqual({ status: 'none' })
    expect(await service.recover({ ...scope, userId: 'other' })).toEqual({ status: 'none' })
    expect(service.isLocked(scope)).toBe(true)
  })
})

describe('recovery task retirement', () => {
  it('invalidates references before retirement and holds lock if retirement fails', async () => {
    const service = createProtectedFillService({ authorize: async () => true, authorizeRecovery: async () => true,
      validateSource: async () => true, readSource: async () => 'secret' })
    const refs = await service.create(scope, [source])
    const items = [{ referenceId: refs.references[0]!.referenceId, ref: '@e1' }]
    await service.reserve(scope, items)
    await expect(service.recover(scope, async locked => {
      expect(locked).toEqual(scope)
      expect(service.isLocked(scope)).toBe(true)
      throw new Error('retirement failed')
    })).rejects.toThrow(PROTECTED_FILL_ERROR)
    expect(service.isLocked(scope)).toBe(true)
    await expect(service.resolve(scope, items)).rejects.toThrow(PROTECTED_FILL_ERROR)
    expect(await service.recover(scope, async () => {})).toEqual({ status: 'cancelled' })
    expect(service.isLocked(scope)).toBe(false)
  })
})
