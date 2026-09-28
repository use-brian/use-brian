import { randomBytes } from 'node:crypto'

/** Values belong only in the extension's direct HTTPS response, never tools. */
export type ProtectedFillScope = {
  userId: string
  workspaceId: string
  sessionId: string
  taskId: string
  browserProfileId: string
  destinationOrigin: string
}
export type ProtectedFillSource = { kind: string; entityId: string; field: string }
export type ProtectedFillItem = { referenceId: string; ref: string }
export const PROTECTED_FILL_ERROR = 'Protected fill unavailable'
export class ProtectedFillDenied extends Error {
  readonly code = 'protected_fill_denied'
  constructor() { super(PROTECTED_FILL_ERROR) }
}
const deny = (): never => { throw new ProtectedFillDenied() }
const scopeKeys = ['userId', 'workspaceId', 'sessionId', 'taskId', 'browserProfileId', 'destinationOrigin'] as const
const key = (scope: Pick<ProtectedFillScope, 'userId' | 'browserProfileId'>) =>
  JSON.stringify([scope.userId, scope.browserProfileId])
const sameScope = (a: ProtectedFillScope, b: ProtectedFillScope) => scopeKeys.every(k => a[k] === b[k])

export function isProtectedFillOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return url.protocol === 'https:' && url.origin === origin && !url.username && !url.password
  } catch { return false }
}

/**
 * Single-instance authority. Boot MUST opt in explicitly; a multi-instance
 * deployment needs a shared transactional implementation before enabling it.
 * No values are stored. Expiration NEVER clears a disclosure lock.
 */
export function createProtectedFillService(deps: {
  authorize: (scope: ProtectedFillScope) => Promise<boolean>
  authorizeCompletion?: (scope: Omit<ProtectedFillScope, 'destinationOrigin'>) => Promise<boolean>
  authorizeRecovery?: (identity: Pick<ProtectedFillScope, 'userId' | 'workspaceId' | 'browserProfileId'>) => Promise<boolean>
  validateSource: (scope: ProtectedFillScope, source: ProtectedFillSource) => Promise<boolean>
  readSource: (scope: ProtectedFillScope, source: ProtectedFillSource) => Promise<string>
  now?: () => number
  maxReferences?: number
}) {
  const now = deps.now ?? Date.now
  const references = new Map<string, { scope: ProtectedFillScope; source: ProtectedFillSource; expiresAt: number }>()
  const epochs = new Map<string, number>()
  const bump = (scope: ProtectedFillScope) => epochs.set(key(scope), (epochs.get(key(scope)) ?? 0) + 1)
  const locks = new Map<string, { scope: ProtectedFillScope; items: ProtectedFillItem[]; resolutionStarted: boolean }>()
  // Serializes creation, dispatch reservation, resolution and completion so
  // permission awaits cannot race consumption or human completion.
  let tail: Promise<unknown> = Promise.resolve()
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn).catch(() => deny())
    tail = result.catch(() => {})
    return result
  }
  function validateScope(scope: ProtectedFillScope) {
    if (!scopeKeys.every(k => typeof scope[k] === 'string' && scope[k].length > 0 && scope[k].length <= 2048) ||
      !isProtectedFillOrigin(scope.destinationOrigin)) deny()
  }
  function prune() {
    for (const [id, entry] of references) if (entry.expiresAt <= now()) references.delete(id)
  }
  function entriesFor(scope: ProtectedFillScope, items: ProtectedFillItem[]) {
    if (items.length < 1 || items.length > 20 ||
      new Set(items.map(i => i.referenceId)).size !== items.length ||
      new Set(items.map(i => i.ref)).size !== items.length) deny()
    return items.map(item => {
      if (!/^[A-Za-z0-9_-]{43}$/.test(item.referenceId) || !/^@e[1-9][0-9]{0,8}$/.test(item.ref)) deny()
      const entry = references.get(item.referenceId)
      if (!entry || entry.expiresAt <= now() || !sameScope(entry.scope, scope)) return deny()
      return entry
    })
  }
  return {
    isLocked(scope: Pick<ProtectedFillScope, 'userId' | 'browserProfileId'>): boolean {
      return locks.has(key(scope))
    },
    epoch(scope: Pick<ProtectedFillScope, 'userId' | 'browserProfileId'>): number {
      return epochs.get(key(scope)) ?? 0
    },
    isSessionLocked(userId: string, sessionId: string): boolean {
      return [...locks.values()].some(lock => lock.scope.userId === userId && lock.scope.sessionId === sessionId)
    },
    create(scope: ProtectedFillScope, sources: ProtectedFillSource[]) {
      return exclusive(async () => {
        validateScope(scope)
        prune()
        if (locks.has(key(scope)) || sources.length < 1 || sources.length > 20 ||
          references.size + sources.length > (deps.maxReferences ?? 10_000) || !await deps.authorize(scope)) deny()
        for (const source of sources) {
          if (!source || !await deps.validateSource(scope, source)) deny()
        }
        const expiresAt = now() + 120_000
        const result = sources.map(source => {
          const referenceId = randomBytes(32).toString('base64url')
          references.set(referenceId, { scope: { ...scope }, source: { ...source }, expiresAt })
          return { referenceId, field: source.field }
        })
        return { references: result, expiresAt }
      })
    },
    /** Called before dispatch. Network failure leaves this reservation locked. */
    reserve(scope: ProtectedFillScope, items: ProtectedFillItem[]) {
      return exclusive(async () => {
        validateScope(scope)
        if (locks.has(key(scope)) || !await deps.authorize(scope)) deny()
        entriesFor(scope, items)
        bump(scope)
        locks.set(key(scope), { scope: { ...scope }, items: items.map(i => ({ ...i })), resolutionStarted: false })
      })
    },
    /** This return value is forbidden from tool/relay/logging surfaces. */
    resolve(scope: ProtectedFillScope, items: ProtectedFillItem[]) {
      return exclusive(async () => {
        validateScope(scope)
        const lock = locks.get(key(scope))
        if ((lock && (lock.resolutionStarted || !sameScope(lock.scope, scope) ||
          lock.items.length !== items.length || lock.items.some((item, i) => item.referenceId !== items[i]?.referenceId || item.ref !== items[i]?.ref))) ||
          !await deps.authorize(scope)) deny()
        const entries = entriesFor(scope, items)
        // Consume entire batch BEFORE any source reads. Any error is terminal.
        bump(scope)
        locks.set(key(scope), { scope: { ...scope }, items: items.map(i => ({ ...i })), resolutionStarted: true })
        for (const item of items) references.delete(item.referenceId)
        const result: { ref: string; value: string }[] = []
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index]!
          if (!await deps.validateSource(scope, entry.source)) deny()
          const value = await deps.readSource(scope, entry.source)
          if (typeof value !== 'string' || value.length > 16_384) deny()
          result.push({ ref: items[index]!.ref, value })
        }
        if (entries.some(entry => entry.expiresAt <= now()) || !await deps.authorize(scope)) deny()
        return { items: result }
      })
    },
    /** Human extension recovery, never a model tool or generic failure handler.
     * Resolution and recovery share the transaction queue: either cancellation
     * invalidates every reference first, or resolution marks disclosure first.
     * Once disclosure started (even failed/uncertain reads), recovery cannot unlock.
     */
    recover(identity: Pick<ProtectedFillScope, 'userId' | 'workspaceId' | 'browserProfileId'>, retireTask: (scope: ProtectedFillScope) => Promise<void> = async () => {}) {
      return exclusive(async () => {
        if (!deps.authorizeRecovery || !await deps.authorizeRecovery(identity)) deny()
        const lock = locks.get(key(identity))
        if (!lock) return { status: 'none' as const }
        if (lock.scope.workspaceId !== identity.workspaceId) return deny()
        if (lock.resolutionStarted) {
          const { userId: _, ...scope } = lock.scope
          return { status: 'cleanup_required' as const, request: { ...scope, items: lock.items.map(item => ({ ...item })) } }
        }
        // A queued/late command may still reach the extension, but no resolver
        // request can use its handles after this point. Invalidate ALL profile
        // references, not just this batch, before releasing the reservation.
        for (const [id, entry] of references) if (key(entry.scope) === key(identity)) references.delete(id)
        bump(lock.scope)
        // Retire the old task before unlocking so delayed commands/completions
        // cannot share a task identity with a freshly issued batch.
        await retireTask({ ...lock.scope })
        locks.delete(key(identity))
        return { status: 'cancelled' as const }
      })
    },
    /** ONLY authenticated extension human-cleanup completion may call this. */
    complete(identity: Omit<ProtectedFillScope, 'destinationOrigin'>, retireTask: () => Promise<void> = async () => {}) {
      return exclusive(async () => {
        const lock = locks.get(key(identity))
        if (!lock) {
          // Idempotent cleanup after an API restart or lost completion response.
          // No task is retired without a matching lock; current profile/member
          // authorization is still mandatory on this extension-only path.
          if (!deps.authorizeCompletion || !await deps.authorizeCompletion(identity)) return deny()
          return
        }
        const scope = { ...identity, destinationOrigin: lock.scope.destinationOrigin }
        validateScope(scope)
        if (!sameScope(lock.scope, scope) || !await (deps.authorizeCompletion ?? deps.authorize)(scope)) deny()
        for (const [id, entry] of references) {
          if (key(entry.scope) === key(scope)) references.delete(id)
        }
        await retireTask()
        locks.delete(key(scope))
      })
    },
  }
}
export type ProtectedFillService = ReturnType<typeof createProtectedFillService>
