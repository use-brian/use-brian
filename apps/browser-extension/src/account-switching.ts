/** Account credentials stay in the app. Only a bounded redirect intent lives here. */
export type AccountBroker = { port: chrome.runtime.Port; hello: Record<string, unknown> }
type Account = { id: string; name: string; email: string }
type Intent = { origin: string; previousUserId: string; accountId?: string; createdAt: number }
type Profile = { id: string; name: string }
const KEY = 'assistantAccountIntent'
const TTL = 10 * 60_000
const bounded = (value: unknown, max = 128): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
function directory(broker: AccountBroker) {
  const raw = broker.hello.accountDirectory as { current?: Account; accounts?: Account[] } | undefined
  if (!raw || !bounded(raw.current?.id) || !Array.isArray(raw.accounts) || raw.accounts.length > 8) return null
  const clean = (a: Account): Account | null => a && bounded(a.id) && typeof a.name === 'string' && a.name.length <= 200 && typeof a.email === 'string' && a.email.length <= 320 ? { id: a.id, name: a.name, email: a.email } : null
  const current = clean(raw.current)
  if (!current || current.id !== broker.hello.userId) return null
  return { current, accounts: raw.accounts.map(clean).filter((a): a is Account => !!a) }
}
export function installAccountSwitching(deps: {
  store: Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>
  brokers: () => AccountBroker[]
  appOrigin: () => Promise<string | null>
  beforeSwitch: () => Promise<void>
  reset: () => void
  publish: (message: unknown) => void
  now?: () => number
}) {
  let changing = false
  let pending: { broker: AccountBroker; id: string; userId: string; workspaceId: unknown; profiles?: Profile[]; pairing?: boolean } | undefined
  let lane: Promise<unknown> = Promise.resolve()
  const now = deps.now ?? Date.now
  const post = (broker: AccountBroker, value: unknown) => { try { broker.port.postMessage(value) } catch { /* reconnect can resume the intent */ } }
  const exclusive = <T,>(fn: () => Promise<T>): Promise<T> => { const result = lane.then(fn); lane = result.catch(() => undefined); return result }
  const read = async (prune = false): Promise<Intent | null> => {
    const raw = (await deps.store.get(KEY))[KEY] as Intent | undefined
    if (!raw) return null
    if (!bounded(raw.origin, 2048) || !bounded(raw.previousUserId) || (raw.accountId !== undefined && !bounded(raw.accountId)) || !Number.isFinite(raw.createdAt) || now() - raw.createdAt < 0 || now() - raw.createdAt > TTL) {
      if (prune) { await deps.store.remove(KEY); pending = undefined }
      return null
    }
    return raw
  }
  const matches = (intent: Intent, broker: AccountBroker) => broker.port.sender?.origin === intent.origin && (intent.accountId ? broker.hello.userId === intent.accountId : broker.hello.userId !== intent.previousUserId)
  const managementBroker = async () => {
    const origin = await deps.appOrigin()
    return [...deps.brokers()].reverse().find(b => (!origin || b.port.sender?.origin === origin) && directory(b))
  }
  const resume = async (broker: AccountBroker) => {
    const intent = await read(true)
    if (!intent || !matches(intent, broker) || !directory(broker) || !bounded(broker.hello.workspaceId) || pending?.broker === broker) return
    pending = { broker, id: crypto.randomUUID(), userId: String(broker.hello.userId), workspaceId: broker.hello.workspaceId }
    post(broker, { type: 'account-profiles', id: pending.id })
  }
  const cancel = async () => {
    if (pending) post(pending.broker, { type: 'account-cancel', id: pending.id })
    pending = undefined; await deps.store.remove(KEY)
    deps.publish({ type: 'account-setup', setup: null })
  }
  return {
    blocked: async () => changing || !!await read(),
    status: async () => {
      const broker = await managementBroker()
      return { ...(broker ? { accountDirectory: directory(broker) } : {}), accountSetup: await read() ? { waiting: true, ...(pending?.profiles ? { profiles: pending.profiles, workspaceName: String(pending.broker.hello.workspaceName ?? ''), pairing: pending.pairing === true } : {}) } : null }
    },
    hello: (broker: AccountBroker) => { void exclusive(() => resume(broker)) },
    disconnected: (broker: AccountBroker) => { if (pending?.broker === broker) pending = undefined },
    panel: async (message: Record<string, unknown>): Promise<boolean> => {
      if (!['account-add', 'account-switch', 'account-connect', 'account-pair', 'account-cancel', 'account-retry', 'account-browsers'].includes(String(message.type))) return false
      await exclusive(async () => {
        try {
          await read(true)
          if (message.type === 'account-cancel') { if (pending?.pairing) throw new Error('pairing_in_progress'); await cancel(); return }
          if (message.type === 'account-retry') {
            if (pending?.pairing) throw new Error('pairing_in_progress')
            if (pending) post(pending.broker, { type: 'account-cancel', id: pending.id })
            pending = undefined
            for (const broker of deps.brokers()) await resume(broker)
            return
          }
          if (message.type === 'account-browsers') {
            if (pending && await read()) post(pending.broker, { type: 'account-browsers' })
            return
          }
          if (message.type === 'account-pair') {
            const intent = await read(true)
            if (!intent || !pending || pending.pairing || !matches(intent, pending.broker) || !pending.profiles?.some(p => p.id === message.profileId)) throw new Error('account_unavailable')
            pending.pairing = true
            deps.publish({ type: 'account-setup', setup: { waiting: true, profiles: pending.profiles, workspaceName: pending.broker.hello.workspaceName, pairing: true } })
            post(pending.broker, { type: 'account-pair', id: pending.id, profileId: message.profileId }); return
          }
          if (pending?.pairing) throw new Error('pairing_in_progress')
          const broker = await managementBroker(), dir = broker && directory(broker)
          if (!broker || !dir) throw new Error('account_unavailable')
          if (message.type === 'account-switch' && (!bounded(message.accountId) || !dir.accounts.some(a => a.id === message.accountId) || message.accountId === dir.current.id)) throw new Error('account_unavailable')
          changing = true
          await deps.beforeSwitch()
          deps.reset()
          await cancel()
          const intent: Intent = { origin: broker.port.sender!.origin!, previousUserId: dir.current.id, createdAt: now(), ...(message.type === 'account-switch' ? { accountId: String(message.accountId) } : message.type === 'account-connect' ? { accountId: dir.current.id } : {}) }
          await deps.store.set({ [KEY]: intent })
          deps.publish({ type: 'account-setup', setup: { waiting: true } })
          if (message.type === 'account-connect') { await resume(broker); return }
          post(broker, { type: 'account-action', action: message.type === 'account-add' ? 'add' : 'switch', ...(intent.accountId ? { accountId: intent.accountId } : {}) })
        } catch (error) {
          deps.publish({ type: 'account-error', code: (error as { code?: string }).code === 'protected_fill_denied' ? 'protected_fill_denied' : (error as Error).message })
        } finally { changing = false }
      })
      return true
    },
    receive: (broker: AccountBroker, message: Record<string, unknown>) => {
      if (!['account-profiles', 'account-paired', 'account-error'].includes(String(message.type))) return false
      void exclusive(async () => {
        const intent = await read(true)
        if (intent && !pending && message.type === 'account-error' && broker.port.sender?.origin === intent.origin && broker.hello.userId === intent.previousUserId) {
          await cancel(); deps.publish({ type: 'account-error', code: 'account_unavailable' }); return
        }
        if (!intent || !pending || pending.broker !== broker || pending.id !== message.id || !matches(intent, broker) || pending.userId !== broker.hello.userId || pending.workspaceId !== broker.hello.workspaceId) return
        if (message.type === 'account-profiles') {
          if (!Array.isArray(message.profiles) || message.profiles.length > 200 || !message.profiles.every(p => p && bounded(p.id) && bounded(p.name, 200))) return
          pending.profiles = message.profiles.map(p => ({ id: p.id, name: p.name }))
          deps.publish({ type: 'account-setup', setup: { waiting: true, profiles: pending.profiles, workspaceName: broker.hello.workspaceName } })
        } else if (message.type === 'account-paired' && message.ok === true) {
          await cancel()
        } else {
          pending.pairing = false
          deps.publish({ type: 'account-error', code: 'account_unavailable' })
        }
      }).catch(() => deps.publish({ type: 'account-error', code: 'account_unavailable' }))
      return true
    },
  }
}
