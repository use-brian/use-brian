import { ExecutorError } from './executor.js'

export const LOCK_KEY = 'protectedDisclosureLock'
export const BROWSER_SESSION_KEY = 'protectedFillBrowserSessionId'
export const denied = () => new ExecutorError('Protected fill unavailable', 'protected_fill_denied')
export type FillRequest = {
  workspaceId: string; sessionId: string; taskId: string; browserProfileId: string
  destinationOrigin: string; items: Array<{referenceId: string; ref: string}>
}
type Lock = { browserSessionId?: string; request: FillRequest; tabIds: number[]; apiBase: string; token: string }
export function validateFill(args: Record<string, unknown>): FillRequest {
  const keys = ['workspaceId','sessionId','taskId','browserProfileId','destinationOrigin','items']
  if (Object.keys(args).length !== keys.length || keys.some(k => !(k in args))) throw denied()
  for (const k of keys.slice(0, 5)) if (typeof args[k] !== 'string' || !(args[k] as string).length || (args[k] as string).length > (k === 'destinationOrigin' ? 2048 : 128)) throw denied()
  const origin = new URL(args.destinationOrigin as string)
  if (origin.protocol !== 'https:' || origin.origin !== args.destinationOrigin) throw denied()
  if (!Array.isArray(args.items) || args.items.length < 1 || args.items.length > 20) throw denied()
  for (const item of args.items) {
    if (!item || Object.keys(item).sort().join() !== 'ref,referenceId' ||
      typeof item.referenceId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(item.referenceId) ||
      typeof item.ref !== 'string' || !/^@e[1-9][0-9]{0,8}$/.test(item.ref)) throw denied()
  }
  if (new Set(args.items.map(i => i.ref)).size !== args.items.length || new Set(args.items.map(i => i.referenceId)).size !== args.items.length) throw denied()
  return args as FillRequest
}
export function trustedApiBase(value: unknown): string {
  if (typeof value !== 'string') throw denied()
  const url = new URL(value)
  if (url.origin !== value || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw denied()
  return value
}
function claimsOf(token: string): {kind: string; userId: string; workspaceId: string; browserProfileId: string; exp: number} {
  return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
}
export function checkIdentity(token: string, request: Pick<FillRequest, 'workspaceId' | 'browserProfileId'>, allowExpired = false): void {
  const claims = claimsOf(token)
  if (claims.kind !== 'browser-ext-session' || typeof claims.userId !== 'string' || !claims.userId ||
    claims.workspaceId !== request.workspaceId || claims.browserProfileId !== request.browserProfileId ||
    !Number.isFinite(claims.exp) || (!allowExpired && claims.exp * 1000 <= Date.now())) throw denied()
}

export class ProtectedFill {
  // Every lock read/modify/write shares one queue. No stale writer can overwrite
  // tab IDs or resurrect a lock after cleanup. Network calls do NOT hold it.
  private writes: Promise<unknown> = Promise.resolve()
  private trackingFailed = false
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writes.then(fn)
    this.writes = result.catch(() => undefined)
    return result
  }
  trackTab(id: number, opener: number): void {
    void this.exclusive(async () => {
      const lock = await this.readLock()
      if (lock && await this.sameBrowserSession(lock) && lock.tabIds.includes(opener) && !lock.tabIds.includes(id)) {
        lock.tabIds.push(id)
        await this.storage.set({[LOCK_KEY]:lock})
      }
    }).catch(() => { this.trackingFailed = true })
  }
  private pending: {request: FillRequest; finish: (approved: boolean) => void} | null = null
  constructor(private readonly storage: Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>) {}
  /** storage.session survives worker suspension, but is cleared by browser restart,
   * extension reload/update/disable. Never synthesize an identity during ordinary
   * cleanup: absence is NOT proof that numeric tab IDs refer to closed pages. */
  private async browserSession(): Promise<string | null> {
    try {
      const value = (await chrome.storage.session.get(BROWSER_SESSION_KEY))[BROWSER_SESSION_KEY]
      return typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value) ? value : null
    } catch { return null }
  }
  private async ensureBrowserSession(): Promise<string> {
    const existing = await this.browserSession()
    if (existing) return existing
    const id = crypto.randomUUID()
    await chrome.storage.session.set({[BROWSER_SESSION_KEY]:id})
    if (await this.browserSession() !== id) throw denied()
    return id
  }
  private async sameBrowserSession(lock: Lock): Promise<boolean> {
    return !!lock.browserSessionId && lock.browserSessionId === await this.browserSession()
  }
  private async requireBrowserSession(lock: Lock): Promise<void> {
    if (!await this.sameBrowserSession(lock)) throw denied()
  }
  private async readLock(): Promise<Lock | undefined> { return (await this.storage.get(LOCK_KEY))[LOCK_KEY] as Lock | undefined }
  async locked(): Promise<boolean> { return !!await this.readLock() }
  async configureApi(value: unknown): Promise<void> {
    const apiBase = trustedApiBase(value)
    await this.exclusive(async () => {
      const lock = await this.readLock()
      // An unconfigured reserved task may be recovered by explicit human setup;
      // once pinned, its endpoint cannot change until cleanup succeeds.
      if (lock && lock.apiBase && lock.apiBase !== apiBase) throw denied()
      if (lock && !lock.apiBase) await this.storage.set({[LOCK_KEY]:{...lock, apiBase}})
      await this.storage.set({protectedApiBase:apiBase})
    })
  }
  async allowCredential(token: string, kind: 'browser-ext-pair' | 'browser-ext-session'): Promise<void> {
    const lock = await this.readLock()
    if (!lock) return
    const before = claimsOf(lock.token)
    const after = claimsOf(token)
    if (after.kind !== kind || after.userId !== before.userId || after.workspaceId !== before.workspaceId ||
      after.browserProfileId !== before.browserProfileId || !Number.isFinite(after.exp) || after.exp * 1000 <= Date.now()) throw denied()
    // Claims here only prevent accidental rebinding. Relay/API verify signatures.
  }
  async status(): Promise<unknown> {
    const lock = await this.readLock()
    const config = await this.storage.get(['protectedApiBase','sessionToken'])
    let needsRenewal = false
    if (lock) {
      try {
        checkIdentity(config.sessionToken ?? lock.token, lock.request)
        await this.allowCredential(config.sessionToken ?? lock.token, 'browser-ext-session')
      } catch { needsRenewal = true }
    }
    return { locked: !!lock, needsSessionRecovery: !!lock && !await this.sameBrowserSession(lock), apiConfigured: !!(lock?.apiBase || config.protectedApiBase), needsRenewal, pending: this.pending ? {
      destinationOrigin: this.pending.request.destinationOrigin,
      browserProfileId: this.pending.request.browserProfileId,
      refs: this.pending.request.items.map(i => i.ref),
    } : null }
  }
  approve(approved: boolean): void { this.pending?.finish(approved) }
  private async post(lock: Pick<Lock, 'apiBase' | 'token'>, path: string, body: unknown): Promise<Response> {
    return fetch(`${trustedApiBase(lock.apiBase)}/api/protected-browser-fill/${path}`, {
      method: 'POST', headers: {'Content-Type':'application/json', Authorization:`Bearer ${lock.token}`},
      body: JSON.stringify(body), cache:'no-store', credentials:'omit', redirect:'error',
      signal: AbortSignal.timeout(20_000),
    })
  }
  /** Trusted human popup recovery of a reservation that never reached this
   * extension. Server cancellation is safe only before resolution; uncertain
   * disclosure is imported WITHOUT session/tab provenance for broad cleanup. */
  async recoverServer(): Promise<'none' | 'cancelled' | 'cleanup_required'> {
    try {
      // Serialize against local lock creation/config changes. No local lock may
      // be cleared or rebound by this path, even if the server restarted.
      return await this.exclusive(async () => {
        if (await this.readLock()) throw denied()
        const config = await this.storage.get(['protectedApiBase','sessionToken'])
        const apiBase = trustedApiBase(config.protectedApiBase)
        if (typeof config.sessionToken !== 'string') throw denied()
        const token = config.sessionToken
        const claims = claimsOf(token)
        if (typeof claims.workspaceId !== 'string' || !claims.workspaceId || claims.workspaceId.length > 128 ||
          typeof claims.browserProfileId !== 'string' || !claims.browserProfileId || claims.browserProfileId.length > 128) throw denied()
        checkIdentity(token, claims)
        const response = await this.post({apiBase, token}, 'recover', {
          workspaceId:claims.workspaceId, browserProfileId:claims.browserProfileId,
        })
        if (!response.ok) throw denied()
        const data = await response.json()
        if (!data || typeof data !== 'object') throw denied()
        if (data.status === 'none' || data.status === 'cancelled') {
          if (Object.keys(data).join() !== 'status') throw denied()
          return data.status
        }
        if (data.status !== 'cleanup_required' || Object.keys(data).sort().join() !== 'request,status') throw denied()
        const request = validateFill(data.request)
        checkIdentity(token, request)
        // Never label a recovered server lock as belonging to today's browser
        // session: restored/material-bearing tabs could have entirely new IDs.
        await this.storage.set({[LOCK_KEY]:{request, tabIds:[], apiBase, token} satisfies Lock})
        void chrome.action.setBadgeText({text:'LOCK'})
        return 'cleanup_required'
      })
    } catch { throw denied() }
  }
  async fill(args: Record<string, unknown>, tabIds: () => number[], prepare: (r: FillRequest) => Promise<(items: Array<{ref:string;value:string}>) => Promise<void>>, check: () => void = () => {}): Promise<unknown> {
    try {
      const request = validateFill(args)
      const config = await this.storage.get(['protectedApiBase','sessionToken'])
      if (typeof config.sessionToken !== 'string') throw denied()
      checkIdentity(config.sessionToken, request, true)
      let apiBase = ''
      try { apiBase = trustedApiBase(config.protectedApiBase) } catch { /* Human setup can recover reserved task. */ }
      const lock: Lock = {request, tabIds: tabIds(), apiBase, token:config.sessionToken}
      // Backend reserves BEFORE dispatch, so even denial/preflight failure needs
      // durable human completion. This is stricter than locking only at resolve.
      await this.exclusive(async () => {
        if (await this.readLock()) throw denied()
        // If session storage is unavailable, still retain backend reservation
        // state, but never resolve values without a durable session binding.
        try { lock.browserSessionId = await this.ensureBrowserSession() } catch { /* fail closed below */ }
        await this.storage.set({[LOCK_KEY]:lock})
      })
      check() // Keep the reservation lock even when Stop raced its creation.
      await this.requireBrowserSession(lock)
      check()
      if (!apiBase) {
        await chrome.windows.create({url:chrome.runtime.getURL('popup.html'), type:'popup', width:420, height:700})
        throw denied()
      }
      checkIdentity(config.sessionToken, request)
      const assign = await prepare(request)
      check()
      // Consent may have added a root tab. Merge, never overwrite popup tracking.
      await this.exclusive(async () => {
        const current = await this.readLock()
        if (!current) throw denied()
        current.tabIds = [...new Set([...current.tabIds, ...tabIds()])]
        await this.storage.set({[LOCK_KEY]:current})
      })
      check() // Stop before pending approval exists must prevent a late popup.
      const approved = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => { this.pending = null; resolve(false) }, 90_000)
        this.pending = {request, finish: answer => { clearTimeout(timer); this.pending = null; resolve(answer) }}
        void chrome.action.setBadgeText({text:'FILL'})
        void chrome.windows.create({url:chrome.runtime.getURL('popup.html'), type:'popup', width:420, height:700}).catch(() => this.approve(false))
      })
      check()
      if (!approved) throw denied()
      await assign([])
      check()
      checkIdentity(config.sessionToken, request)
      await this.requireBrowserSession(lock)
      check()
      const response = await this.post(lock, 'resolve', request)
      if (!response.ok) throw denied()
      const data = await response.json()
      if (!data || Object.keys(data).join() !== 'items' || !Array.isArray(data.items) || data.items.length !== request.items.length) throw denied()
      for (let i=0; i<data.items.length; i++) {
        if (Object.keys(data.items[i]).sort().join() !== 'ref,value' || data.items[i].ref !== request.items[i].ref ||
          typeof data.items[i].value !== 'string' || data.items[i].value.length > 16_384) throw denied()
      }
      await this.requireBrowserSession(lock)
      check() // A resolver response arriving after Stop is never assigned.
      await assign(data.items)
      check()
      return {status:'filled', filledCount:request.items.length, requiresHumanCompletion:true}
    } catch { throw denied() }
    finally { void chrome.action.setBadgeText({text:await this.locked() ? 'LOCK' : ''}) }
  }
  /** Atomically incorporate all current opener descendants, then persist BEFORE closing. */
  private async collectTabs(): Promise<{lock: Lock; live: number[]}> {
    return this.exclusive(async () => {
      if (this.trackingFailed) throw denied()
      const lock = await this.readLock()
      if (!lock) throw denied()
      await this.requireBrowserSession(lock)
      const tabs = await chrome.tabs.query({})
      let added = true
      while (added) {
        added = false
        for (const tab of tabs) {
          if (tab.id != null && tab.openerTabId != null && lock.tabIds.includes(tab.openerTabId) && !lock.tabIds.includes(tab.id)) {
            lock.tabIds.push(tab.id)
            added = true
          }
        }
      }
      await this.storage.set({[LOCK_KEY]:lock})
      return {lock, live:lock.tabIds.filter(id => tabs.some(t => t.id === id))}
    })
  }
  private async closeTabs(): Promise<Lock> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const {lock, live} = await this.collectTabs()
      if (!live.length) return lock
      await this.requireBrowserSession(lock)
      await chrome.tabs.remove(live)
    }
    throw denied()
  }
  private async requireRecoverySession(recovery: {session: string; keeperId: number; keeperUrl: string}): Promise<void> {
    if (await this.browserSession() !== recovery.session ||
      (await chrome.tabs.get(recovery.keeperId)).url !== recovery.keeperUrl) throw denied()
  }
  /** Explicitly approved broad cleanup ONLY; never consult stale numeric IDs.
   * No identity rebinding is persisted. Failure/restart requires fresh approval. */
  private async closeAllTabs(recovery: {session: string; keeperId: number; keeperUrl: string}): Promise<Lock> {
    for (let attempt = 0; attempt < 20; attempt++) {
      await this.requireRecoverySession(recovery)
      const lock = await this.readLock()
      if (!lock) throw denied()
      const tabs = (await chrome.tabs.query({})).filter(t => t.id !== recovery.keeperId)
      if (tabs.some(t => t.id == null)) throw denied()
      if (!tabs.length) return lock
      await this.requireRecoverySession(recovery)
      await chrome.tabs.remove(tabs.map(t => t.id!))
    }
    throw denied()
  }
  async complete(detach: () => Promise<void>, explicitlyCloseAllTabs = false): Promise<void> {
    try {
      let close = () => this.closeTabs()
      let recovery: {session: string; keeperId: number; keeperUrl: string} | undefined
      if (explicitlyCloseAllTabs) {
        const original = await this.readLock()
        if (!original || await this.sameBrowserSession(original)) throw denied()
        const session = await this.exclusive(() => this.ensureBrowserSession())
        // Keep one known-clean extension page alive so closing the final browser
        // window cannot terminate the worker before completion is acknowledged.
        const keeperUrl = chrome.runtime.getURL('popup.html#protected-cleanup')
        const window = await chrome.windows.create({url:keeperUrl, type:'popup', width:420, height:700})
        const keeperId = window.tabs?.[0]?.id
        if (keeperId == null) throw denied()
        recovery = {session, keeperId, keeperUrl}
        close = () => this.closeAllTabs(recovery!)
      }
      const lock = await close()
      await detach()
      await close()
      // Re-pairing can renew an expired JWT, but never change user/workspace/profile.
      const config = await this.storage.get('sessionToken')
      if (typeof config.sessionToken === 'string') {
        await this.allowCredential(config.sessionToken, 'browser-ext-session')
        lock.token = config.sessionToken
      }
      checkIdentity(lock.token, lock.request)
      const {workspaceId, sessionId, taskId, browserProfileId} = lock.request
      if (!(await this.post(lock, 'complete', {workspaceId,sessionId,taskId,browserProfileId})).ok) throw denied()
      // Events arriving during API await are merged before final cleanup, and no
      // queued storage writer can restore a removed lock afterwards.
      await close()
      await this.exclusive(async () => {
        if (this.trackingFailed && !recovery) throw denied()
        const latest = await this.readLock()
        if (!latest) throw denied()
        if (recovery) {
          await this.requireRecoverySession(recovery)
          if ((await chrome.tabs.query({})).some(t => t.id !== recovery!.keeperId)) throw denied()
        } else {
          await this.requireBrowserSession(latest)
          if ((await chrome.tabs.query({})).some(t => t.id != null &&
            (latest.tabIds.includes(t.id) || (t.openerTabId != null && latest.tabIds.includes(t.openerTabId))))) throw denied()
        }
        await this.storage.remove(LOCK_KEY)
      })
      void chrome.action.setBadgeText({text:''})
    } catch { throw denied() }
  }
}
