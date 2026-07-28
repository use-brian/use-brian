/**
 * OSS process singleton for ChatGPT-plan authentication and inference.
 *
 * The manager owns the isolated Codex app-server lifecycle, keeps the shared
 * model-availability gate synchronized with account/model discovery, and
 * exposes a stable LLMProvider proxy so routing survives one process restart.
 *
 * Spec: docs/plans/chatgpt-codex-oauth.md
 * [COMP:api/codex-provider]
 */
import {
  CodexAccountClient,
  CodexCatalogClient,
  CodexRpcClosedError,
  createCodexAppServerProvider,
  startCodexAppServer,
  type CodexAccountStatus,
  type CodexAppServerProcess,
  type CodexBrowserLogin,
  type CodexCatalogModel,
  type CodexDeviceCodeLogin,
  type LLMProvider,
  type ProviderRequest,
  type ProviderSession,
  type SessionOptions,
  type StreamChunk,
} from '@use-brian/core'
import {
  MutableProviderAvailability,
  providerModelIds,
  registryRow,
} from '@use-brian/shared/model-registry'

const PROVIDER_ID = 'openai-codex'
const RESTART_BACKOFF_MS = 500

type StartProcess = typeof startCodexAppServer

type Runtime = {
  process: CodexAppServerProcess
  account: CodexAccountClient
  catalog: CodexCatalogClient
  provider: LLMProvider
  removeCloseListener: () => void
}

export type CodexProviderStatus = {
  runtimeAvailable: boolean
  account: CodexAccountStatus
  models: CodexCatalogModel[]
  preferredProvider: OssPreferredProvider
}

export type OssPreferredProvider = 'auto' | 'gemini' | 'openai-codex' | 'dashscope-intl'

export type StartCodexProviderManagerOptions = {
  availability: MutableProviderAvailability
  codexHome?: string
  startProcess?: StartProcess
  restartBackoffMs?: number
  savePreferredProvider?: (provider: OssPreferredProvider) => Promise<void>
}

export interface CodexProviderManager {
  provider: LLMProvider
  refresh(): Promise<CodexProviderStatus>
  status(): Promise<CodexProviderStatus>
  startBrowserLogin(): Promise<CodexBrowserLogin>
  startDeviceCodeLogin(): Promise<CodexDeviceCodeLogin>
  cancelLogin(loginId: string): Promise<void>
  logout(): Promise<void>
  setPreferredProvider(provider: OssPreferredProvider): Promise<void>
  close(): Promise<void>
}

export async function startCodexProviderManager(
  options: StartCodexProviderManagerOptions,
): Promise<CodexProviderManager> {
  const manager = new ManagedCodexProvider(options)
  try {
    await manager.start()
  } catch {
    // The subscription lane is optional. Keep a disconnected manager alive so
    // local status/login/preference routes remain available when the pinned
    // binary is temporarily missing or cannot start. Later status/login calls
    // retry #ensureRuntime; other configured providers continue serving.
  }
  return manager
}

class ManagedCodexProvider implements CodexProviderManager {
  readonly #availability: MutableProviderAvailability
  readonly #codexHome: string | undefined
  readonly #startProcess: StartProcess
  readonly #restartBackoffMs: number
  readonly #reviewedModels = providerModelIds(PROVIDER_ID)
  readonly #savePreferredProvider:
    | ((provider: OssPreferredProvider) => Promise<void>)
    | undefined
  readonly provider: LLMProvider

  #runtime: Runtime | undefined
  #starting: Promise<void> | undefined
  #closed = false
  #restartBudget = 1
  #restartTimer: ReturnType<typeof setTimeout> | undefined
  #lastStatus: CodexProviderStatus = disconnectedStatus(false)

  constructor(options: StartCodexProviderManagerOptions) {
    this.#availability = options.availability
    this.#codexHome = options.codexHome
    this.#startProcess = options.startProcess ?? startCodexAppServer
    this.#restartBackoffMs = positiveInteger(
      options.restartBackoffMs,
      RESTART_BACKOFF_MS,
      'restartBackoffMs',
    )
    this.#savePreferredProvider = options.savePreferredProvider
    this.provider = this.#createProviderProxy()
  }

  async start(): Promise<void> {
    await this.#ensureRuntime()
  }

  async refresh(): Promise<CodexProviderStatus> {
    const runtime = await this.#requireRuntime()
    const account = await runtime.account.readAccount()
    if (!account.connected || account.authType !== 'chatgpt') {
      this.#availability.setModelCatalog(PROVIDER_ID, null)
      this.#lastStatus = {
        runtimeAvailable: true,
        account,
        models: [],
        preferredProvider: this.#preferredProvider(),
      }
      return this.#lastStatus
    }

    const catalog = await runtime.catalog.listModels()
    const reviewed = catalog.models.filter((model) => {
      const row = registryRow(model.model)
      return (
        row?.provider === PROVIDER_ID &&
        row.apiModelId === model.model &&
        row.status === 'active'
      )
    })
    this.#availability.setModelCatalog(
      PROVIDER_ID,
      new Set(reviewed.map((model) => model.model)),
    )
    this.#lastStatus = {
      runtimeAvailable: true,
      account,
      models: reviewed,
      preferredProvider: this.#preferredProvider(),
    }
    return this.#lastStatus
  }

  async status(): Promise<CodexProviderStatus> {
    try {
      return await this.refresh()
    } catch {
      // Account refresh, revocation, catalog, and transport errors all remove
      // the provider from dispatch immediately. A stale entitlement must never
      // remain callable just because status refresh failed.
      this.#availability.setModelCatalog(PROVIDER_ID, null)
      this.#lastStatus = disconnectedStatus(Boolean(this.#runtime), this.#preferredProvider())
      return this.#lastStatus
    }
  }

  async startBrowserLogin(): Promise<CodexBrowserLogin> {
    return (await this.#requireRuntime()).account.startBrowserLogin()
  }

  async startDeviceCodeLogin(): Promise<CodexDeviceCodeLogin> {
    return (await this.#requireRuntime()).account.startDeviceCodeLogin()
  }

  async cancelLogin(loginId: string): Promise<void> {
    await (await this.#requireRuntime()).account.cancelLogin(loginId)
  }

  async logout(): Promise<void> {
    await (await this.#requireRuntime()).account.logout()
    this.#availability.setModelCatalog(PROVIDER_ID, null)
    this.#lastStatus = disconnectedStatus(true, this.#preferredProvider())
  }

  async setPreferredProvider(provider: OssPreferredProvider): Promise<void> {
    await this.#savePreferredProvider?.(provider)
    this.#availability.setPreferredProvider(provider)
    this.#lastStatus = {
      ...this.#lastStatus,
      preferredProvider: provider,
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (this.#restartTimer) clearTimeout(this.#restartTimer)
    this.#restartTimer = undefined
    this.#availability.setModelCatalog(PROVIDER_ID, null)
    const runtime = this.#runtime
    this.#runtime = undefined
    runtime?.removeCloseListener()
    runtime?.account.close()
    await runtime?.process.close()
  }

  async #ensureRuntime(): Promise<void> {
    if (this.#closed) throw new CodexRpcClosedError('Codex provider manager is closed')
    if (this.#runtime) return
    if (this.#starting) return this.#starting
    this.#starting = this.#startRuntime()
    try {
      await this.#starting
    } finally {
      this.#starting = undefined
    }
  }

  async #startRuntime(): Promise<void> {
    const process = await this.#startProcess({
      ...(this.#codexHome ? { codexHome: this.#codexHome } : {}),
      surface: 'inference',
    })
    if (this.#closed) {
      await process.close()
      throw new CodexRpcClosedError('Codex provider manager closed during startup')
    }
    const account = new CodexAccountClient(process.rpc)
    const catalog = new CodexCatalogClient(process.rpc)
    const provider = createCodexAppServerProvider({
      transport: { rpc: process.rpc, cwd: process.cwd },
      models: this.#reviewedModels,
    })
    const runtime = {
      process,
      account,
      catalog,
      provider,
      removeCloseListener: () => {},
    } satisfies Runtime
    runtime.removeCloseListener = process.rpc.onClose(() => this.#handleRuntimeClose(runtime))
    this.#runtime = runtime
    try {
      await this.refresh()
    } catch (error) {
      if (!isClosedError(error)) {
        this.#availability.setModelCatalog(PROVIDER_ID, null)
        this.#lastStatus = disconnectedStatus(true, this.#preferredProvider())
      }
      if (isClosedError(error)) throw error
    }
  }

  #handleRuntimeClose(runtime: Runtime): void {
    if (this.#runtime !== runtime) return
    this.#runtime = undefined
    runtime.removeCloseListener()
    runtime.account.close()
    this.#availability.setModelCatalog(PROVIDER_ID, null)
    this.#lastStatus = disconnectedStatus(false, this.#preferredProvider())
    void runtime.process.close()
    if (this.#closed || this.#restartBudget <= 0 || this.#restartTimer) return
    this.#restartBudget--
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined
      void this.#ensureRuntime().catch(() => {
        this.#availability.setModelCatalog(PROVIDER_ID, null)
      })
    }, this.#restartBackoffMs)
    this.#restartTimer.unref?.()
  }

  async #requireRuntime(): Promise<Runtime> {
    await this.#ensureRuntime()
    if (!this.#runtime) throw new CodexRpcClosedError('Codex provider runtime is unavailable')
    return this.#runtime
  }

  #createProviderProxy(): LLMProvider {
    const current = (): LLMProvider => {
      const provider = this.#runtime?.provider
      if (!provider) {
        throw new CodexRpcClosedError(
          'ChatGPT provider is unavailable; reconnect or restart Use Brian',
        )
      }
      return provider
    }
    return {
      name: PROVIDER_ID,
      models: [...this.#reviewedModels],
      stream(request: ProviderRequest): AsyncIterable<StreamChunk> {
        return current().stream(request)
      },
      createSession(options: SessionOptions): ProviderSession {
        return current().createSession(options)
      },
    }
  }

  #preferredProvider(): OssPreferredProvider {
    const value = this.#availability.preferredProvider
    return value === 'gemini' ||
      value === 'openai-codex' ||
      value === 'dashscope-intl'
      ? value
      : 'auto'
  }
}

function disconnectedStatus(
  runtimeAvailable: boolean,
  preferredProvider: OssPreferredProvider = 'auto',
): CodexProviderStatus {
  return {
    runtimeAvailable,
    account: {
      connected: false,
      authType: 'none',
      planType: null,
      emailHint: null,
      requiresOpenaiAuth: true,
    },
    models: [],
    preferredProvider,
  }
}

function isClosedError(error: unknown): boolean {
  return error instanceof CodexRpcClosedError
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return resolved
}
