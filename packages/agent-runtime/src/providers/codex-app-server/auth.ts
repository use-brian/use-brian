import { z } from 'zod'
import {
  AccountLoginCompletedNotificationSchema,
  BrowserLoginResponseSchema,
  DeviceCodeLoginResponseSchema,
  GetAccountResponseSchema,
  type AccountLoginCompletedNotification,
  type CodexPlanType,
} from './protocol.js'
import { CodexRpcClosedError, type CodexRpcPeer } from './rpc.js'

const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000
const MAX_REMEMBERED_COMPLETIONS = 32
const EmptyResponseSchema = z.object({}).passthrough()

export type CodexAccountStatus = {
  connected: boolean
  authType: 'chatgpt' | 'apiKey' | 'amazonBedrock' | 'none'
  planType: CodexPlanType | null
  emailHint: string | null
  requiresOpenaiAuth: boolean
}

export type CodexBrowserLogin = {
  type: 'chatgpt'
  loginId: string
  authUrl: string
}

export type CodexDeviceCodeLogin = {
  type: 'chatgptDeviceCode'
  loginId: string
  verificationUrl: string
  userCode: string
}

export type WaitForCodexLoginOptions = {
  timeoutMs?: number
  signal?: AbortSignal
}

type LoginWaiter = {
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  removeAbortListener?: () => void
}

export class CodexLoginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexLoginError'
  }
}

export class CodexAccountClient {
  readonly #rpc: CodexRpcPeer
  readonly #completed = new Map<string, AccountLoginCompletedNotification>()
  readonly #waiters = new Map<string, Set<LoginWaiter>>()
  readonly #removeLoginNotification: () => void
  readonly #removeCloseHandler: () => void
  #closed = false

  constructor(rpc: CodexRpcPeer) {
    this.#rpc = rpc
    this.#removeLoginNotification = rpc.onNotification(
      'account/login/completed',
      (params) => this.#handleLoginCompletion(params),
    )
    this.#removeCloseHandler = rpc.onClose((reason) => this.#close(reason))
  }

  async readAccount(refreshToken = false): Promise<CodexAccountStatus> {
    const response = await this.#rpc.request(
      'account/read',
      { refreshToken },
      GetAccountResponseSchema,
    )
    const account = response.account
    if (!account) {
      return {
        connected: false,
        authType: 'none',
        planType: null,
        emailHint: null,
        requiresOpenaiAuth: response.requiresOpenaiAuth,
      }
    }
    if (account.type === 'chatgpt') {
      return {
        connected: true,
        authType: 'chatgpt',
        planType: account.planType,
        emailHint: account.email ? maskEmail(account.email) : null,
        requiresOpenaiAuth: response.requiresOpenaiAuth,
      }
    }
    return {
      connected: false,
      authType: account.type,
      planType: null,
      emailHint: null,
      requiresOpenaiAuth: response.requiresOpenaiAuth,
    }
  }

  async startBrowserLogin(): Promise<CodexBrowserLogin> {
    const response = await this.#rpc.request(
      'account/login/start',
      {
        type: 'chatgpt',
        appBrand: 'chatgpt',
        useHostedLoginSuccessPage: true,
      },
      BrowserLoginResponseSchema,
    )
    assertOpenAiAuthUrl(response.authUrl)
    return response
  }

  async startDeviceCodeLogin(): Promise<CodexDeviceCodeLogin> {
    const response = await this.#rpc.request(
      'account/login/start',
      { type: 'chatgptDeviceCode' },
      DeviceCodeLoginResponseSchema,
    )
    assertOpenAiAuthUrl(response.verificationUrl)
    return response
  }

  async waitForLogin(
    loginId: string,
    options: WaitForCodexLoginOptions = {},
  ): Promise<CodexAccountStatus> {
    assertLoginId(loginId)
    if (this.#closed) throw new CodexRpcClosedError()

    const remembered = this.#completed.get(loginId)
    if (remembered) {
      this.#completed.delete(loginId)
      this.#assertSuccessfulCompletion(remembered)
      return this.readAccount(true)
    }

    if (options.signal?.aborted) throw abortError()
    const timeoutMs = positiveInteger(
      options.timeoutMs,
      DEFAULT_LOGIN_TIMEOUT_MS,
      'timeoutMs',
    )

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#removeWaiter(loginId, waiter)
        reject(new CodexLoginError('ChatGPT login timed out'))
      }, timeoutMs)
      const waiter: LoginWaiter = { resolve, reject, timeout }

      if (options.signal) {
        const onAbort = () => {
          this.#removeWaiter(loginId, waiter)
          reject(abortError())
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
        waiter.removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort)
      }

      const waiters = this.#waiters.get(loginId) ?? new Set<LoginWaiter>()
      waiters.add(waiter)
      this.#waiters.set(loginId, waiters)
    })

    return this.readAccount(true)
  }

  async cancelLogin(loginId: string): Promise<void> {
    assertLoginId(loginId)
    await this.#rpc.request(
      'account/login/cancel',
      { loginId },
      EmptyResponseSchema,
    )
  }

  async logout(): Promise<void> {
    await this.#rpc.request('account/logout', {}, EmptyResponseSchema)
  }

  close(): void {
    this.#close(new CodexRpcClosedError('Codex account client closed'))
  }

  #handleLoginCompletion(params: unknown): void {
    const parsed = AccountLoginCompletedNotificationSchema.safeParse(params)
    if (!parsed.success || !parsed.data.loginId) return
    const { loginId } = parsed.data
    const waiters = this.#waiters.get(loginId)
    if (!waiters || waiters.size === 0) {
      this.#completed.set(loginId, parsed.data)
      while (this.#completed.size > MAX_REMEMBERED_COMPLETIONS) {
        const oldest = this.#completed.keys().next().value as string | undefined
        if (oldest === undefined) break
        this.#completed.delete(oldest)
      }
      return
    }

    this.#waiters.delete(loginId)
    for (const waiter of waiters) {
      this.#cleanupWaiter(waiter)
      try {
        this.#assertSuccessfulCompletion(parsed.data)
        waiter.resolve()
      } catch (error) {
        waiter.reject(error as Error)
      }
    }
  }

  #assertSuccessfulCompletion(completion: AccountLoginCompletedNotification): void {
    if (!completion.success) {
      throw new CodexLoginError('ChatGPT login failed or was cancelled')
    }
  }

  #removeWaiter(loginId: string, waiter: LoginWaiter): void {
    this.#cleanupWaiter(waiter)
    const waiters = this.#waiters.get(loginId)
    waiters?.delete(waiter)
    if (waiters?.size === 0) this.#waiters.delete(loginId)
  }

  #cleanupWaiter(waiter: LoginWaiter): void {
    clearTimeout(waiter.timeout)
    waiter.removeAbortListener?.()
  }

  #close(reason: Error): void {
    if (this.#closed) return
    this.#closed = true
    this.#removeLoginNotification()
    this.#removeCloseHandler()
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) {
        this.#cleanupWaiter(waiter)
        waiter.reject(reason)
      }
    }
    this.#waiters.clear()
    this.#completed.clear()
  }
}

function assertOpenAiAuthUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new CodexLoginError('Codex returned an invalid ChatGPT authorization URL')
  }
  const hostname = url.hostname.toLowerCase()
  const allowedHost =
    hostname === 'openai.com'
    || hostname.endsWith('.openai.com')
    || hostname === 'chatgpt.com'
    || hostname.endsWith('.chatgpt.com')
  if (
    url.protocol !== 'https:'
    || !allowedHost
    || (url.port !== '' && url.port !== '443')
    || url.username !== ''
    || url.password !== ''
  ) {
    throw new CodexLoginError('Codex returned an untrusted ChatGPT authorization URL')
  }
}

function maskEmail(email: string): string {
  const separator = email.lastIndexOf('@')
  if (separator <= 0 || separator === email.length - 1) return '***'
  const local = email.slice(0, separator)
  const domain = email.slice(separator + 1)
  return `${local.slice(0, 1)}${'*'.repeat(Math.min(3, Math.max(1, local.length - 1)))}@${domain}`
}

function assertLoginId(loginId: string): void {
  if (loginId.length === 0 || loginId.length > 256) {
    throw new TypeError('loginId must contain between 1 and 256 characters')
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return resolved
}

function abortError(): Error {
  const error = new Error('ChatGPT login wait aborted')
  error.name = 'AbortError'
  return error
}
