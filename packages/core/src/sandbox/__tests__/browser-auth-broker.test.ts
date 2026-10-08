import { describe, expect, it, vi } from 'vitest'
import { createBrowserAuthBroker } from '../browser-auth-broker.js'
import type {
  BrowserCredentialFailureCode,
  BrowserCredentialResolver,
  BrowserCredentialResolved,
} from '../browser-credentials.js'
import { createSandboxOrchestrator, createInMemorySandboxTaskStore } from '../orchestrator.js'
import { createInMemorySessionVault, type BrowserProfile } from '../profiles.js'
import { StubSandboxProvider } from '../providers/stub.js'

const SECRET = { username: 'member@example.com', password: 'never-show-this-password' }

function resolved(): BrowserCredentialResolved {
  return {
    metadata: {
      id: 'cred-1',
      workspaceId: 'ws-1',
      profileId: 'profile-1',
      site: 'example.com',
      loginUrl: 'https://accounts.example.com/login',
      accountLabel: 'Primary account',
      status: 'active',
      lastUsedAt: null,
      lastFailureCode: null,
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    },
    secret: SECRET,
    version: 'envelope-version-1',
  }
}

class LoginSandboxProvider extends StubSandboxProvider {
  constructor(private readonly challenge: 'none' | 'mfa' = 'none') {
    super()
  }

  override browser(sandboxId: string) {
    const base = super.browser(sandboxId)
    return {
      ...base,
      navigate: async (url: string) => {
        await base.navigate(url)
        this.setPage(sandboxId, {
          url: 'https://accounts.example.com/login',
          title: 'Sign in',
          snapshot: {
            url: 'https://accounts.example.com/login',
            title: 'Sign in',
            nodes:
              this.challenge === 'mfa'
                ? [{ ref: '@e1', role: 'textbox', name: 'Verification code' }]
                : [
                    { ref: '@e1', role: 'textbox', name: 'Email' },
                    { ref: '@e2', role: 'textbox', name: 'Password' },
                    { ref: '@e3', role: 'button', name: 'Sign in' },
                  ],
          },
        })
        return { url: 'https://accounts.example.com/login' }
      },
      click: async (ref: string) => {
        await base.click(ref)
        this.setPage(sandboxId, {
          url: 'https://accounts.example.com/account',
          title: 'Account',
          snapshot: {
            url: 'https://accounts.example.com/account',
            title: 'Account',
            nodes: [{ ref: '@e9', role: 'heading', name: 'Welcome' }],
          },
        })
      },
    }
  }
}

function harness(challenge: 'none' | 'mfa' = 'none') {
  const provider = new LoginSandboxProvider(challenge)
  const taskStore = createInMemorySandboxTaskStore()
  const vault = createInMemorySessionVault()
  const records: Array<{ result: 'success' | 'failure'; failureCode?: BrowserCredentialFailureCode }> = []
  const resolutions: Array<{
    userId: string
    workspaceId: string
    profileId: string
    site: string
    credentialId?: string
  }> = []
  const credentials: BrowserCredentialResolver = {
    async resolve(params) {
      resolutions.push(params)
      return resolved()
    },
    async recordResult(params) {
      expect(params).toMatchObject({userId:'user-1',workspaceId:'ws-1',profileId:'profile-1',credentialId:'cred-1',version:'envelope-version-1'})
      records.push({ result: params.result, failureCode: params.failureCode })
    },
  }
  const profile: BrowserProfile = {
    id: 'profile-1', workspaceId: 'ws-1', ownerUserId: 'user-1', name: 'Fictional login', scope: 'owner',
    clearance: 'internal', departmentId: null, enabledAssistantIds: [], defaultBackend: 'cloud',
    localControlMode: 'task_tabs', proxyUrl: null, createdAt: '', updatedAt: '',
  }
  const orchestrator = createSandboxOrchestrator({ provider, taskStore, vault,
    profileStore: { get: async id => id === profile.id ? profile : null } })
  const broker = createBrowserAuthBroker({ provider, orchestrator, credentials })
  return { provider, taskStore, vault, records, resolutions, broker, credentials }
}

describe('[COMP:sandbox/browser-auth-broker] isolated model-free login', () => {
  it('withholds a prepared authentication success when authority expires during teardown', async () => {
    const h = harness()
    let allowed = true
    const authority = {
      assertCurrent: async () => { if (!allowed) throw new Error('revoked') },
      execute: async <T>(operation: () => Promise<T>): Promise<T> => {
        await authority.assertCurrent()
        const result = await operation()
        await authority.assertCurrent()
        return result
      },
    }
    const kill = h.provider.kill.bind(h.provider)
    vi.spyOn(h.provider, 'kill').mockImplementation(async id => { allowed = false; await kill(id) })
    expect(await h.broker.authenticate({ userId: 'user-1', workspaceId: 'ws-1', profileId: 'profile-1', site: 'example.com', authority }))
      .toEqual({ kind: 'failed', code: 'auth_unavailable' })
    expect(h.records).toContainEqual({ result: 'success' })
    expect([...h.provider.sandboxes.values()][0]?.status).toBe('killed')
  })

  it('refuses credential resolution when the originating execution is already revoked', async () => {
    const h = harness()
    const authority = { assertCurrent: async () => { throw new Error('revoked') }, execute: async <T>(operation: () => Promise<T>) => operation() }
    expect(await h.broker.authenticate({ userId: 'user-1', workspaceId: 'ws-1', profileId: 'profile-1', site: 'example.com', authority }))
      .toEqual({ kind: 'failed', code: 'auth_unavailable' })
    expect(h.resolutions).toEqual([])
    expect(h.provider.sandboxes.size).toBe(0)
  })

  it('renews the source after the awaited URL check before releasing either secret', async () => {
    const h = harness()
    let allowed = true
    const authority = { assertCurrent: async () => { if (!allowed) throw new Error('revoked') },
      execute: async <T>(operation: () => Promise<T>): Promise<T> => { await authority.assertCurrent(); const result = await operation(); await authority.assertCurrent(); return result } }
    const original = h.provider.browser.bind(h.provider)
    vi.spyOn(h.provider, 'browser').mockImplementation(id => {
      const browser = original(id)
      return { ...browser, currentUrl: async () => { const url = await browser.currentUrl(); allowed = false; return url } }
    })
    expect(await h.broker.authenticate({ userId: 'user-1', workspaceId: 'ws-1', profileId: 'profile-1', site: 'example.com', authority }))
      .toEqual({ kind: 'failed', code: 'auth_unavailable' })
    const sandbox = [...h.provider.sandboxes.values()][0]
    expect(sandbox.status).toBe('killed')
    expect(sandbox.actions.some(action => action.op === 'typeSecret' || action.op === 'click')).toBe(false)
    expect(h.records).toEqual([])
    expect(await h.vault.get({ profileId: 'profile-1', site: 'example.com' })).toBeNull()
  })

  it('exchanges a credential for a vaulted session without recording plaintext actions', async () => {
    const { provider, taskStore, vault, records, resolutions, broker } = harness()

    const result = await broker.authenticate({
      userId: 'user-1',
      workspaceId: 'ws-1',
      profileId: 'profile-1',
      site: 'example.com',
    })

    expect(result).toEqual({ kind: 'authenticated', credentialId: 'cred-1', credentialVersion: 'envelope-version-1', site: 'example.com' })
    expect(resolutions[0]).toEqual({
        userId: 'user-1',
        workspaceId: 'ws-1',
        profileId: 'profile-1',
        site: 'example.com',
      })
    expect(resolutions).toHaveLength(7)
    for (const renewal of resolutions.slice(1)) expect(renewal).toEqual({...resolutions[0],credentialId:'cred-1'})
    expect(await vault.get({ profileId: 'profile-1', site: 'example.com' })).not.toBeNull()
    expect(records).toContainEqual({ result: 'success', failureCode: undefined })
    const sandbox = [...provider.sandboxes.values()][0]
    expect(sandbox?.status).toBe('killed')
    expect(sandbox?.actions.filter((action) => action.op === 'typeSecret')).toEqual([
      { op: 'typeSecret', args: { ref: '@e1', redacted: true } },
      { op: 'typeSecret', args: { ref: '@e2', redacted: true } },
    ])
    expect(JSON.stringify(sandbox?.actions)).not.toContain(SECRET.username)
    expect(JSON.stringify(sandbox?.actions)).not.toContain(SECRET.password)
    expect([...taskStore.tasks.values()][0]?.status).toBe('completed')
  })

  it('stops at MFA, persists no session, and kills the auth sandbox', async () => {
    const { provider, vault, records, broker } = harness('mfa')

    const result = await broker.authenticate({
      userId: 'user-1',
      workspaceId: 'ws-1',
      profileId: 'profile-1',
      site: 'example.com',
    })

    expect(result).toEqual({ kind: 'needs_user', code: 'mfa_required' })
    expect(await vault.get({ profileId: 'profile-1', site: 'example.com' })).toBeNull()
    expect(records).toContainEqual({ result: 'failure', failureCode: 'mfa_required' })
    expect([...provider.sandboxes.values()][0]?.status).toBe('killed')
  })

  it.each([2,3,4,5,6])('stops at renewal %s after revocation without persisting a session', async (deniedCall) => {
    const h=harness()
    const resolve=vi.spyOn(h.credentials,'resolve').mockResolvedValue(null)
    for(let i=1;i<deniedCall;i++)resolve.mockResolvedValueOnce(resolved())
    expect(await h.broker.authenticate({userId:'user-1',workspaceId:'ws-1',profileId:'profile-1',site:'example.com'}))
      .toEqual({kind:'failed',code:'auth_unavailable'})
    const sandbox=[...h.provider.sandboxes.values()][0]
    expect(sandbox.status).toBe('killed')
    expect(sandbox.actions.filter(action=>action.op==='typeSecret')).toHaveLength(Math.min(2,deniedCall-2))
    expect(sandbox.actions.filter(action=>action.op==='click')).toHaveLength(deniedCall>4?1:0)
    expect(await h.vault.get({profileId:'profile-1',site:'example.com'})).toBeNull()
    expect(h.records.some(record=>record.result==='success')).toBe(false)
  })

  it.each(['version','id','workspaceId','profileId','site','loginUrl'] as const)('refuses changed %s before filling either field', async(field)=>{
    const h=harness()
    const replacement=resolved()
    if(field==='version')replacement.version='replacement-version'
    else replacement.metadata[field]='replacement-value'
    vi.spyOn(h.credentials,'resolve').mockResolvedValue(replacement)
      .mockResolvedValueOnce(resolved())
    expect(await h.broker.authenticate({userId:'user-1',workspaceId:'ws-1',profileId:'profile-1',site:'example.com'}))
      .toEqual({kind:'failed',code:'auth_unavailable'})
    const sandbox=[...h.provider.sandboxes.values()][0]
    expect(sandbox.actions.some(action=>action.op==='typeSecret'||action.op==='click')).toBe(false)
    expect(sandbox.status).toBe('killed')
  })

  it.each([1,2])('returns a non-disclosing failure when lookup %s throws',async(failingCall)=>{
    const h=harness()
    const resolve=vi.spyOn(h.credentials,'resolve').mockRejectedValue(new Error('private storage diagnostic'))
    if(failingCall===2)resolve.mockResolvedValueOnce(resolved())
    const result=await h.broker.authenticate({userId:'user-1',workspaceId:'ws-1',profileId:'profile-1',site:'example.com'})
    expect(result).toEqual({kind:'failed',code:'auth_unavailable'})
    for(const sandbox of h.provider.sandboxes.values())expect(sandbox.status).toBe('killed')
  })

  it('rejects mismatched resolver identity before creating a sandbox',async()=>{
    const h=harness(), wrong=resolved()
    wrong.metadata.profileId='another-profile'
    vi.spyOn(h.credentials,'resolve').mockResolvedValue(wrong)
    expect(await h.broker.authenticate({userId:'user-1',workspaceId:'ws-1',profileId:'profile-1',site:'example.com'}))
      .toEqual({kind:'failed',code:'auth_unavailable'})
    expect(h.provider.sandboxes.size).toBe(0)
  })
})
