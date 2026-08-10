import { describe, expect, it } from 'vitest'
import { createBrowserAuthBroker } from '../browser-auth-broker.js'
import type {
  BrowserCredentialFailureCode,
  BrowserCredentialResolver,
  BrowserCredentialResolved,
} from '../browser-credentials.js'
import { createSandboxOrchestrator, createInMemorySandboxTaskStore } from '../orchestrator.js'
import { createInMemorySessionVault } from '../profiles.js'
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
      records.push({ result: params.result, failureCode: params.failureCode })
    },
  }
  const orchestrator = createSandboxOrchestrator({ provider, taskStore, vault })
  const broker = createBrowserAuthBroker({ provider, orchestrator, credentials })
  return { provider, taskStore, vault, records, resolutions, broker }
}

describe('[COMP:sandbox/browser-auth-broker] isolated model-free login', () => {
  it('exchanges a credential for a vaulted session without recording plaintext actions', async () => {
    const { provider, taskStore, vault, records, resolutions, broker } = harness()

    const result = await broker.authenticate({
      userId: 'user-1',
      workspaceId: 'ws-1',
      profileId: 'profile-1',
      site: 'example.com',
    })

    expect(result).toEqual({ kind: 'authenticated', credentialId: 'cred-1', site: 'example.com' })
    expect(resolutions).toEqual([
      {
        userId: 'user-1',
        workspaceId: 'ws-1',
        profileId: 'profile-1',
        site: 'example.com',
      },
    ])
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
})
