import type { AuthoritySource } from '../security/authority-source.js'
import type { AuthoringAuthority } from '../security/access-ceiling.js'
import type { CurrentAuthorityBoundary } from '../tools/types.js'
/**
 * Host-owned, model-free browser authentication. Plaintext credentials are
 * resolved only inside this module, used in a separate task-ledgered sandbox,
 * and exchanged for the ordinary encrypted session bundle the assistant's
 * cloud sandbox already knows how to consume.
 *
 * [COMP:sandbox/browser-auth-broker]
 */
import { randomUUID } from 'node:crypto'
import type {
  BrowserSnapshot,
  BrowserSnapshotNode,
  SandboxProvider,
  SessionBundle,
} from './types.js'
import type { SandboxOrchestrator } from './orchestrator.js'
import type {
  BrowserCredentialFailureCode,
  BrowserCredentialResolver,
} from './browser-credentials.js'
import { createCloudBrowserProvider } from './cloud-browser-provider.js'
import { looksLikeCaptcha, looksLikeLoginWall, registrableSiteOf } from './orchestrator.js'

export type BrowserAuthResult =
  | { kind: 'authenticated'; credentialId: string; credentialVersion: string; site: string }
  | { kind: 'unavailable'; code: 'no_credential' | 'not_configured' }
  | { kind: 'needs_user'; code: 'human_verification' | 'mfa_required' }
  | { kind: 'failed'; code: Exclude<BrowserCredentialFailureCode, 'human_verification' | 'mfa_required'> }

export interface BrowserAuthBroker {
  authenticate(params: {
    userId: string
    workspaceId: string
    profileId: string
    site: string
    credentialId?: string
    sourceAuthority?: AuthoritySource
    inputScope?: import('./input-scope.js').BrowserInputScope
    executionAuthority?: AuthoringAuthority
    authority?: CurrentAuthorityBoundary
  }): Promise<BrowserAuthResult>
}

const USERNAME_PATTERN =
  /\b(e-?mail|user(?:name| id)?|member(?:ship)?(?: number| id)?|account(?: number| id)?|login id|mobile|phone)\b/i
const PASSWORD_PATTERN = /\b(password|passcode|pin)\b/i
const MFA_PATTERN =
  /\b(one[- ]time|otp|verification code|security code|authenticator|two[- ]factor|2fa|passkey)\b/i
const SUBMIT_PATTERN = /\b(sign[ -]?in|log[ -]?in|continue|next|submit)\b/i

type ActionableSnapshotNode = BrowserSnapshotNode & { ref: string }
type PickResult = { kind: 'none' } | { kind: 'one'; node: ActionableSnapshotNode } | { kind: 'many' }

function pick(nodes: BrowserSnapshotNode[], pattern: RegExp, roles?: Set<string>): PickResult {
  const matches = nodes.filter((node): node is ActionableSnapshotNode =>
    typeof node.ref === 'string' &&
    !node.disabled &&
    (!roles || roles.has(node.role.toLowerCase())) &&
    pattern.test(node.name),
  )
  if (matches.length === 0) return { kind: 'none' }
  if (matches.length > 1) return { kind: 'many' }
  return { kind: 'one', node: matches[0] }
}

function credentialField(snapshot: BrowserSnapshot, kind: 'username' | 'password'): PickResult {
  const pattern = kind === 'username' ? USERNAME_PATTERN : PASSWORD_PATTERN
  return pick(snapshot.nodes, pattern, new Set(['textbox', 'combobox']))
}

function submitControl(snapshot: BrowserSnapshot): PickResult {
  return pick(snapshot.nodes, SUBMIT_PATTERN, new Set(['button']))
}

function pageAllowed(url: string, site: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && registrableSiteOf(url) === site
  } catch {
    return false
  }
}

function bundleHasState(bundle: SessionBundle): boolean {
  if (bundle.cookies.length > 0) return true
  return Object.keys(bundle.localStorage ?? {}).length > 0
}

function failure(
  code: BrowserCredentialFailureCode,
): Extract<BrowserAuthResult, { kind: 'failed' | 'needs_user' }> {
  if (code === 'human_verification' || code === 'mfa_required') {
    return { kind: 'needs_user', code }
  }
  return { kind: 'failed', code }
}

export function createBrowserAuthBroker(deps: {
  provider: SandboxProvider
  orchestrator: SandboxOrchestrator
  credentials: BrowserCredentialResolver
}): BrowserAuthBroker {
  return {
    async authenticate(params) {
      const site = params.site.trim().toLowerCase()
      const identity = {
        userId: params.userId,
        workspaceId: params.workspaceId,
        profileId: params.profileId,
        site,
        ...(params.credentialId ? { credentialId: params.credentialId } : {}),
      }
      let authorityUnavailable = false
      const sourceCurrent = async () => {
        try { await params.authority?.assertCurrent() }
        catch { authorityUnavailable = true; throw new Error('Source authority unavailable') }
      }
      let resolved: Awaited<ReturnType<BrowserCredentialResolver['resolve']>>
      try { await sourceCurrent(); resolved = await deps.credentials.resolve(identity); await sourceCurrent() }
      catch { return { kind: 'failed', code: 'auth_unavailable' } }
      if (!resolved) return { kind: 'unavailable', code: 'no_credential' }
      const { metadata, secret } = resolved
      const credentialId = metadata.id
      if (metadata.workspaceId !== params.workspaceId || metadata.profileId !== params.profileId
        || !resolved.version || (params.credentialId && credentialId !== params.credentialId)) {
        return { kind: 'failed', code: 'auth_unavailable' }
      }
      const receipt = { userId: params.userId, workspaceId: params.workspaceId,
        profileId: params.profileId, credentialId, version: resolved.version }
      const renew = async () => {
        try {
          await sourceCurrent()
          const current = await deps.credentials.resolve({ ...identity, credentialId })
          await sourceCurrent()
          if (!current || current.version !== receipt.version || current.metadata.id !== credentialId
            || current.metadata.workspaceId !== params.workspaceId || current.metadata.profileId !== params.profileId
            || current.metadata.site !== site || current.metadata.loginUrl !== metadata.loginUrl) throw new Error('Credential changed')
        } catch {
          authorityUnavailable = true
          throw new Error('Credential authority unavailable')
        }
      }

      // The saved URL is the user's authority boundary, not a model-provided
      // URL. Refuse stale/corrupt metadata before a sandbox sees plaintext.
      if (metadata.site !== site || !pageAllowed(metadata.loginUrl, site)) {
        await deps.credentials.recordResult({
          ...receipt,
          result: 'failure',
          failureCode: 'cross_site_redirect',
        }).catch(() => undefined)
        return { kind: 'failed', code: 'cross_site_redirect' }
      }

      const sessionId = randomUUID()
      const cloud = createCloudBrowserProvider({
        provider: deps.provider,
        // Deliberately use the bare binding. The auth sandbox must never
        // recursively invoke automatic credential recovery on itself.
        binding: deps.orchestrator.binding,
      })
      let result: BrowserAuthResult = { kind: 'failed', code: 'backend_error' }
      let completed = false
      try {
        await cloud.navigate(
          {
            userId: params.userId,
            workspaceId: params.workspaceId,
            sessionId,
            profileId: params.profileId,
            authority: params.authority,
            executionAuthority: params.executionAuthority,
            sourceAuthority: params.sourceAuthority,
            inputScope: params.inputScope,
          },
          metadata.loginUrl,
        )
        const task = await deps.orchestrator.getActiveTask(sessionId)
        if (!task) {
          result = { kind: 'failed', code: 'auth_unavailable' }
          return result
        }
        await sourceCurrent()
        await deps.provider.connect(task.sandboxId)
        await sourceCurrent()
        const browser = deps.provider.browser(task.sandboxId)
        if (!browser.typeSecret) {
          result = { kind: 'failed', code: 'auth_unavailable' }
          return result
        }

        let submitted = false
        let usernameFilled = false
        for (let step = 0; step < 4; step += 1) {
          await sourceCurrent()
          const snapshot = await browser.snapshot()
          await sourceCurrent()
          if (!pageAllowed(snapshot.url, site)) {
            result = failure('cross_site_redirect')
            return result
          }
          if (looksLikeCaptcha(snapshot)) {
            result = failure('human_verification')
            return result
          }
          const password = credentialField(snapshot, 'password')
          const username = credentialField(snapshot, 'username')
          // An optional "use a passkey instead" control commonly sits next
          // to a perfectly usable password field. Treat MFA/passkey copy as
          // blocking only once no password input is available.
          if (
            password.kind === 'none' &&
            snapshot.nodes.some((node) => MFA_PATTERN.test(node.name))
          ) {
            result = failure('mfa_required')
            return result
          }

          // After a submitted form, leaving both login fields and the login
          // URL is the bounded success signal. Capture still has to produce
          // actual cookie/storage state below.
          if (
            submitted &&
            password.kind === 'none' &&
            username.kind === 'none' &&
            !looksLikeLoginWall(snapshot.url)
          ) {
            await renew()
            const bundle = await browser.captureStorageState(site)
            if (!bundleHasState(bundle)) {
              result = failure('empty_session')
              return result
            }
            await renew()
            await deps.orchestrator.captureSession(sessionId, site, params.profileId, params.authority)
            await sourceCurrent()
            await deps.credentials.recordResult({ ...receipt, result: 'success' })
            await renew()
            completed = true
            result = { kind: 'authenticated', credentialId, credentialVersion: resolved.version, site }
            return result
          }

          if (password.kind === 'many' || (!usernameFilled && username.kind === 'many')) {
            result = failure('field_ambiguous')
            return result
          }

          let filled = false
          if (!usernameFilled && username.kind === 'one') {
            await renew()
            if (!pageAllowed((await browser.currentUrl()).url, site)) {
              result = failure('cross_site_redirect')
              return result
            }
            await sourceCurrent()
            await browser.typeSecret(username.node.ref, secret.username)
            await sourceCurrent()
            usernameFilled = true
            filled = true
          }
          if (password.kind === 'one') {
            await renew()
            if (!pageAllowed((await browser.currentUrl()).url, site)) {
              result = failure('cross_site_redirect')
              return result
            }
            await sourceCurrent()
            await browser.typeSecret(password.node.ref, secret.password)
            await sourceCurrent()
            filled = true
          }
          if (!filled) {
            result = failure(submitted ? 'login_rejected' : 'field_not_found')
            return result
          }

          const submit = submitControl(snapshot)
          if (submit.kind === 'many') {
            result = failure('field_ambiguous')
            return result
          }
          if (submit.kind === 'none') {
            result = failure('submit_not_found')
            return result
          }
          // Re-check immediately before the state-changing click. A page can
          // redirect between snapshot and fill; no secret may cross sites.
          await renew()
          const current = await browser.currentUrl()
          if (!pageAllowed(current.url, site)) {
            result = failure('cross_site_redirect')
            return result
          }
          await sourceCurrent()
          await browser.click(submit.node.ref)
          await sourceCurrent()
          submitted = true
        }

        result = failure('login_rejected')
        return result
      } catch {
        await sourceCurrent().catch(() => undefined)
        result = { kind: 'failed', code: authorityUnavailable ? 'auth_unavailable' : 'backend_error' }
        return result
      } finally {
        await sourceCurrent().catch(() => undefined)
        if (result.kind !== 'authenticated' && !authorityUnavailable) {
          await deps.credentials
            .recordResult({
              ...receipt,
              result: 'failure',
              failureCode: result.code,
            })
            .catch(() => undefined)
        }
        // Every path kills the auth sandbox through the ordinary lifecycle,
        // preserving metering/task-ledger behavior. On success capture was
        // completed before teardown; on failure no session is persisted.
        await deps.orchestrator
          .completeTask(sessionId, completed ? 'completed' : 'failed', params.authority)
          .catch(() => undefined)
        await sourceCurrent().catch(() => undefined)
        if (authorityUnavailable) return { kind: 'failed', code: 'auth_unavailable' }
      }
    },
  }
}
