import type { IdentityWorkspace, IdentityPickerLabels } from '@use-brian/chat-ui'
import { isTrustedPairingOrigin } from './pairing.js'

/** Open canonical sign-in in a normal browser tab, preserving any OAuth redirect. */
export function createAccountSignIn(deps: {
  appOrigin: () => Promise<string | null>
  matches: () => string[]
  tabs: Pick<typeof chrome.tabs, 'get' | 'update' | 'create'>
  windows: Pick<typeof chrome.windows, 'getLastFocused' | 'update' | 'create'>
}) {
  let tabId: number | undefined
  let tabOrigin: string | undefined
  return async () => {
    const saved = await deps.appOrigin()
    const origin = saved && isTrustedPairingOrigin(saved, deps.matches()) ? new URL(saved).origin : 'https://app.usebrian.ai'
    const existing = tabId === undefined || tabOrigin !== origin ? null : await deps.tabs.get(tabId).catch(() => null)
    if (existing?.id !== undefined && !existing.incognito) {
      await deps.tabs.update(existing.id, { active: true })
      await deps.windows.update(existing.windowId, { focused: true })
      return
    }
    const window = await deps.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null)
    if (window?.id !== undefined && !window.incognito) {
      tabId = (await deps.tabs.create({ windowId: window.id, url: `${origin}/`, active: true })).id
    } else {
      const created = await deps.windows.create({ url: `${origin}/`, type: 'normal', incognito: false, focused: true })
      tabId = created?.tabs?.[0]?.id
    }
    tabOrigin = origin
  }
}

/** Account credentials stay in the app. Only a bounded redirect intent lives here. */
export type AccountBroker = { port: chrome.runtime.Port; hello: Record<string, unknown> }
type Account = { id: string; name: string; email: string; avatarUrl?: string }
type Intent = { origin: string; previousUserId: string; accountId?: string; workspaceId?: string; resetMissing?: boolean; createdAt: number }
type Profile = { id: string; name: string }
const KEY = 'assistantAccountIntent'
const TTL = 10 * 60_000
const bounded = (value: unknown, max = 128): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
function directory(broker: AccountBroker) {
  const raw = broker.hello.accountDirectory as { current?: Account; accounts?: Account[]; canManageAccounts?: boolean } | undefined
  if (!raw || !bounded(raw.current?.id) || !Array.isArray(raw.accounts) || raw.accounts.length > 8) return null
  const clean = (a: Account): Account | null => a && bounded(a.id) && typeof a.name === 'string' && a.name.length <= 200 && typeof a.email === 'string' && a.email.length <= 320 ? { id: a.id, name: a.name, email: a.email, ...(publicImage(a.avatarUrl) ? { avatarUrl: a.avatarUrl } : {}) } : null
  const current = clean(raw.current)
  if (!current || current.id !== broker.hello.userId) return null
  return { current, ...(raw.canManageAccounts === false ? { canManageAccounts: false } : {}), accounts: raw.accounts.map(clean).filter((a): a is Account => !!a) }
}
function publicImage(value: unknown): value is string {
  if (!bounded(value, 2048)) return false
  try { const url = new URL(value); return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) } catch { return false }
}
function workspaceDirectory(broker: AccountBroker) {
  const raw = broker.hello.workspaceDirectory as { active?: IdentityWorkspace; workspaces?: IdentityWorkspace[] } | undefined
  if (!raw || !bounded(raw.active?.id) || raw.active.id !== broker.hello.workspaceId || !Array.isArray(raw.workspaces) || raw.workspaces.length > 1000) return null
  const clean = (w: IdentityWorkspace): IdentityWorkspace | null => {
    if (!w || !bounded(w.id) || !bounded(w.name, 200)) return null
    const item: IdentityWorkspace = { id: w.id, name: w.name }
    if (Number.isSafeInteger(w.iconSeed)) item.iconSeed = w.iconSeed
    if (publicImage(w.iconUrl)) item.iconUrl = w.iconUrl
    for (const key of ['pickerPinnedAt', 'pickerHiddenAt', 'pickerLastOpenedAt'] as const) if (bounded(w[key], 64) && Number.isFinite(Date.parse(w[key]!))) item[key] = w[key]
    return item
  }
  const active = clean(raw.active)
  return active ? { active, workspaces: raw.workspaces.map(clean).filter((w): w is IdentityWorkspace => !!w) } : null
}
function pickerLabels(broker: AccountBroker): IdentityPickerLabels | undefined {
  const raw = broker.hello.identityPickerLabels as IdentityPickerLabels | undefined
  const keys = ['searchPlaceholder', 'empty', 'addAnotherAccount', 'switchAccountAria', 'switcherAriaLabel'] as const
  return raw && keys.every(key => bounded(raw[key], 500)) ? Object.fromEntries(keys.map(key => [key, raw[key]])) as IdentityPickerLabels : undefined
}
export function installAccountSwitching(deps: {
  store: Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>
  brokers: () => AccountBroker[]
  appOrigin: () => Promise<string | null>
  beforeSwitch: () => Promise<void>
  reset: () => void
  publish: (message: unknown) => void
  installationId?: () => Promise<string>
  currentProfile?: (broker: AccountBroker) => Promise<string | undefined>
  beforeAutomaticConnect?: () => Promise<void>
  now?: () => number
}) {
  let changing = false
  let pending: { broker: AccountBroker; id: string; userId: string; workspaceId: unknown; profiles?: Profile[]; pairing?: boolean; automatic?: boolean; failed?: boolean; failure?: string } | undefined
  const attempted = new Set<string>()
  const targetKey = (broker: AccountBroker) => `${broker.port.sender?.origin}/${broker.hello.userId}/${broker.hello.workspaceId}`
  let lane: Promise<unknown> = Promise.resolve()
  const now = deps.now ?? Date.now
  const post = (broker: AccountBroker, value: unknown) => { try { broker.port.postMessage(value) } catch { /* reconnect can resume the intent */ } }
  const exclusive = <T,>(fn: () => Promise<T>): Promise<T> => { const result = lane.then(fn); lane = result.catch(() => undefined); return result }
  const read = async (prune = false): Promise<Intent | null> => {
    const raw = (await deps.store.get(KEY))[KEY] as Intent | undefined
    if (!raw) return null
    if (!bounded(raw.origin, 2048) || !bounded(raw.previousUserId) || (raw.accountId !== undefined && !bounded(raw.accountId)) || (raw.workspaceId !== undefined && !bounded(raw.workspaceId)) || (raw.resetMissing !== undefined && typeof raw.resetMissing !== 'boolean') || !Number.isFinite(raw.createdAt) || now() - raw.createdAt < 0 || now() - raw.createdAt > TTL) {
      if (prune) { await deps.store.remove(KEY); pending = undefined }
      return null
    }
    return raw
  }
  const matches = (intent: Intent, broker: AccountBroker) => broker.port.sender?.origin === intent.origin && (!intent.workspaceId || broker.hello.workspaceId === intent.workspaceId) && (intent.accountId ? broker.hello.userId === intent.accountId : broker.hello.userId !== intent.previousUserId)
  const managementBroker = async () => {
    const origin = await deps.appOrigin()
    return [...deps.brokers()].reverse().find(b => (!origin || b.port.sender?.origin === origin) && directory(b))
  }
  const resume = async (broker: AccountBroker) => {
    const intent = await read(true)
    if (!intent || !matches(intent, broker) || !directory(broker) || !bounded(broker.hello.workspaceId) || pending?.broker === broker) return
    pending = { broker, id: crypto.randomUUID(), userId: String(broker.hello.userId), workspaceId: broker.hello.workspaceId }
    if (broker.hello.automaticBrowser === true && deps.installationId) {
      const attempt = pending
      attempted.add(targetKey(broker))
      attempt.automatic = true; attempt.pairing = true
      deps.publish({ type: 'account-setup', setup: { waiting: true, automatic: true, pairing: true } })
      try {
        const installationId = await deps.installationId(), currentProfileId = await deps.currentProfile?.(broker)
        post(broker, { type: 'browser-connect', id: attempt.id, installationId, ...(currentProfileId ? { currentProfileId } : {}), ...(intent.resetMissing ? { resetMissing: true } : {}) })
      } catch { attempt.pairing = false; attempt.failed = true; deps.publish({ type: 'account-error', code: 'account_unavailable' }) }
    } else post(broker, { type: 'account-profiles', id: pending.id })
  }
  const cancel = async () => {
    if (pending) post(pending.broker, { type: 'account-cancel', id: pending.id })
    pending = undefined; await deps.store.remove(KEY)
    deps.publish({ type: 'account-setup', setup: null })
  }
  return {
    ensureConnection: () => exclusive(async () => {
      if (await read()) return
      const broker = await managementBroker(), dir = broker && directory(broker)
      if (!broker || !dir || broker.hello.automaticBrowser !== true || !deps.installationId || attempted.has(targetKey(broker))) return
      attempted.add(targetKey(broker))
      try {
        await deps.beforeAutomaticConnect?.()
        await deps.store.set({ [KEY]: { origin: broker.port.sender!.origin!, previousUserId: dir.current.id, accountId: dir.current.id, workspaceId: broker.hello.workspaceId, createdAt: now() } })
        await resume(broker)
      } catch (error) { deps.publish({ type: 'account-error', code: (error as { code?: string }).code === 'protected_fill_denied' ? 'protected_fill_denied' : 'busy' }) }
    }),
    blocked: async () => changing || !!await read(),
    status: async () => {
      const broker = await managementBroker()
      return { ...(broker ? { accountDirectory: directory(broker), workspaceDirectory: workspaceDirectory(broker), identityPickerLabels: pickerLabels(broker) } : {}), accountSetup: await read() ? { waiting: true, ...(pending?.automatic ? { automatic: true, pairing: pending.pairing === true, failed: pending.failed === true } : {}), ...(pending?.profiles ? { profiles: pending.profiles, workspaceName: String(pending.broker.hello.workspaceName ?? ''), pairing: pending.pairing === true } : {}) } : null }
    },
    hello: (broker: AccountBroker) => { void exclusive(() => resume(broker)) },
    disconnected: (broker: AccountBroker) => { attempted.delete(targetKey(broker)); if (pending?.broker === broker) pending = undefined },
    panel: async (message: Record<string, unknown>): Promise<boolean> => {
      if (!['account-add', 'account-switch', 'workspace-switch', 'account-connect', 'account-pair', 'account-cancel', 'account-retry', 'account-browsers'].includes(String(message.type))) return false
      await exclusive(async () => {
        try {
          await read(true)
          if (message.type === 'account-cancel') { if (pending?.pairing) throw new Error('pairing_in_progress'); await cancel(); return }
          if (message.type === 'account-retry') {
            if (pending?.pairing) throw new Error('pairing_in_progress')
            if (pending?.automatic && pending.failure === 'browser_identity_changed') {
              const intent = await read(true)
              if (intent) await deps.store.set({ [KEY]: { ...intent, resetMissing: true } })
            }
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
          if (['account-add', 'account-switch'].includes(String(message.type)) && dir.canManageAccounts === false) throw new Error('account_unavailable')
          if (message.type === 'workspace-switch' && (!bounded(message.workspaceId) || !workspaceDirectory(broker)?.workspaces.some(w => w.id === message.workspaceId))) throw new Error('account_unavailable')
          if (message.type === 'account-switch' && (!bounded(message.accountId) || !dir.accounts.some(a => a.id === message.accountId) || message.accountId === dir.current.id)) throw new Error('account_unavailable')
          changing = true
          await deps.beforeSwitch()
          deps.reset()
          await cancel()
          const intent: Intent = { origin: broker.port.sender!.origin!, previousUserId: dir.current.id, createdAt: now(), ...(message.type === 'account-switch' ? { accountId: String(message.accountId) } : message.type === 'account-connect' ? { accountId: dir.current.id, workspaceId: String(broker.hello.workspaceId) } : message.type === 'workspace-switch' ? { accountId: dir.current.id, workspaceId: String(message.workspaceId) } : {}) }
          await deps.store.set({ [KEY]: intent })
          deps.publish({ type: 'account-setup', setup: { waiting: true } })
          if (message.type === 'account-connect') { await resume(broker); return }
          if (message.type === 'workspace-switch') { post(broker, { type: 'workspace-action', workspaceId: intent.workspaceId }); return }
          post(broker, { type: 'account-action', action: message.type === 'account-add' ? 'add' : 'switch', ...(intent.accountId ? { accountId: intent.accountId } : {}) })
        } catch (error) {
          deps.publish({ type: 'account-error', code: (error as { code?: string }).code === 'protected_fill_denied' ? 'protected_fill_denied' : (error as Error).message })
        } finally { changing = false }
      })
      return true
    },
    receive: (broker: AccountBroker, message: Record<string, unknown>) => {
      if (!['account-profiles', 'account-paired', 'browser-connected', 'account-error'].includes(String(message.type))) return false
      void exclusive(async () => {
        const intent = await read(true)
        if (intent && !pending && message.type === 'account-error' && broker.port.sender?.origin === intent.origin && broker.hello.userId === intent.previousUserId) {
          await cancel(); deps.publish({ type: 'account-error', code: 'account_unavailable' }); return
        }
        if (!intent || !pending || pending.broker !== broker || pending.id !== message.id || !matches(intent, broker) || pending.userId !== broker.hello.userId || pending.workspaceId !== broker.hello.workspaceId) return
        if (message.type === 'browser-connected' && pending.automatic && bounded(message.profileId)) {
          await cancel()
        } else if (message.type === 'account-profiles') {
          if (!Array.isArray(message.profiles) || message.profiles.length > 200 || !message.profiles.every(p => p && bounded(p.id) && bounded(p.name, 200))) return
          pending.profiles = message.profiles.map(p => ({ id: p.id, name: p.name }))
          deps.publish({ type: 'account-setup', setup: { waiting: true, profiles: pending.profiles, workspaceName: broker.hello.workspaceName } })
        } else if (message.type === 'account-paired' && message.ok === true) {
          await cancel()
        } else {
          pending.pairing = false; pending.failed = true; pending.failure = typeof message.code === 'string' ? message.code : undefined
          deps.publish({ type: 'account-error', code: ['browser_identity_changed', 'browser_connection_busy', 'browser_connect_failed'].includes(String(message.code)) ? message.code : 'account_unavailable' })
        }
      }).catch(() => deps.publish({ type: 'account-error', code: 'account_unavailable' }))
      return true
    },
  }
}
