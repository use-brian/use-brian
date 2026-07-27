import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { z } from 'zod'
import {
  InitializeParamsSchema,
  InitializeResponseSchema,
  PINNED_CODEX_VERSION,
  type InitializeResponse,
} from './protocol.js'
import { CodexRpcClosedError, CodexRpcPeer } from './rpc.js'

const DEFAULT_MAX_STDERR_BYTES = 64 * 1024
const DEFAULT_INFERENCE_MAX_FRAME_BYTES = 8 * 1024 * 1024
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000
const DEFAULT_CODEX_HOME = join(homedir(), '.usebrian', 'codex')
const P0_REQUEST_METHODS = new Set(['initialize'])
const P0_NOTIFICATION_METHODS = new Set(['initialized'])
const ACCOUNT_REQUEST_METHODS = new Set([
  ...P0_REQUEST_METHODS,
  'account/read',
  'account/login/start',
  'account/login/cancel',
  'account/logout',
  'model/list',
])
const INFERENCE_REQUEST_METHODS = new Set([
  ...ACCOUNT_REQUEST_METHODS,
  'thread/start',
  'thread/inject_items',
  'thread/unsubscribe',
  'turn/start',
  'turn/interrupt',
])

const DISABLED_INFERENCE_FEATURES = [
  'apps',
  'artifact',
  'auth_elicitation',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'code_mode',
  'code_mode_buffered_exec',
  'code_mode_host',
  'code_mode_only',
  'computer_use',
  'current_time_reminder',
  'default_mode_request_user_input',
  'deferred_executor',
  'executor_capability_discovery',
  'goals',
  'guardian_approval',
  'hooks',
  'image_generation',
  'in_app_browser',
  'memories',
  'multi_agent',
  'multi_agent_v2',
  'plugin_sharing',
  'plugins',
  'remote_plugin',
  'request_permissions_tool',
  'shell_snapshot',
  'shell_tool',
  'skill_mcp_dependency_install',
  'skill_search',
  'tool_call_mcp_elicitation',
  'tool_suggest',
  'unified_exec',
  'workspace_dependencies',
] as const

/**
 * Exact strict-config profile covered by the real-runtime request-capture
 * contract. Keep the integration test and production process on this one
 * shared list so a new native capability cannot drift into only one path.
 */
export const CODEX_INFERENCE_HARDENING_ARGS: readonly string[] = [
  '--strict-config',
  '-c',
  'web_search="disabled"',
  '-c',
  'tools.experimental_request_user_input.enabled=false',
  '-c',
  'tools.update_plan.enabled=false',
  '-c',
  'agents.enabled=false',
  '-c',
  'orchestrator.skills.enabled=false',
  '-c',
  'orchestrator.mcp.enabled=false',
  '-c',
  'skills.bundled.enabled=false',
  '-c',
  'skills.include_instructions=false',
  '-c',
  'include_apps_instructions=false',
  '-c',
  'include_collaboration_mode_instructions=false',
  '-c',
  'include_environment_context=false',
  '-c',
  'include_permissions_instructions=false',
  '-c',
  'project_root_markers=[]',
  '-c',
  'shell_environment_policy.inherit="none"',
  ...DISABLED_INFERENCE_FEATURES.flatMap((feature) => ['--disable', feature]),
]

const ALLOWED_ENV_KEYS = [
  'PATH',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'SSL_CERT_FILE',
  'CODEX_CA_CERTIFICATE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const

const PackageJsonSchema = z.object({
  name: z.literal('@openai/codex'),
  version: z.string(),
})

export type CodexCommand = {
  command: string
  argsPrefix?: string[]
}

export type StartCodexAppServerOptions = {
  codexHome?: string
  command?: CodexCommand
  surface?: 'foundation' | 'account' | 'inference'
  clientVersion?: string
  maxFrameBytes?: number
  maxPendingRequests?: number
  requestTimeoutMs?: number
  maxStderrBytes?: number
  shutdownTimeoutMs?: number
  signal?: AbortSignal
}

export type CodexProcessDiagnostics = {
  stderrBytes: number
  stderrTruncated: boolean
}

export type CodexAppServerProcess = {
  rpc: CodexRpcPeer
  initialize: InitializeResponse
  codexHome: string
  cwd: string
  pid: number | undefined
  diagnostics(): CodexProcessDiagnostics
  close(): Promise<void>
}

export function buildCodexEnvironment(
  codexHome: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    CODEX_HOME: codexHome,
    RUST_LOG: source.RUST_LOG ?? 'warn',
  }
  for (const key of ALLOWED_ENV_KEYS) {
    if (source[key] !== undefined) environment[key] = source[key]
  }
  return environment
}

export async function resolvePinnedCodexCommand(): Promise<CodexCommand> {
  const require = createRequire(import.meta.url)
  const packageJsonPath = require.resolve('@openai/codex/package.json')
  const packageJson = PackageJsonSchema.parse(JSON.parse(await readFile(packageJsonPath, 'utf8')))
  if (packageJson.version !== PINNED_CODEX_VERSION) {
    throw new Error(
      `Unsupported @openai/codex version ${packageJson.version}; expected ${PINNED_CODEX_VERSION}`,
    )
  }
  return {
    command: process.execPath,
    argsPrefix: [require.resolve('@openai/codex/bin/codex.js')],
  }
}

export async function startCodexAppServer(
  options: StartCodexAppServerOptions = {},
): Promise<CodexAppServerProcess> {
  if (options.signal?.aborted) throw abortError()

  const codexHome = options.codexHome ?? DEFAULT_CODEX_HOME
  if (!isAbsolute(codexHome)) {
    throw new TypeError('codexHome must be an absolute path')
  }
  const maxStderrBytes = positiveInteger(
    options.maxStderrBytes,
    DEFAULT_MAX_STDERR_BYTES,
    'maxStderrBytes',
  )
  const shutdownTimeoutMs = positiveInteger(
    options.shutdownTimeoutMs,
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    'shutdownTimeoutMs',
  )
  const command = options.command ?? (await resolvePinnedCodexCommand())
  const allowedRequestMethods =
    options.surface === 'inference'
      ? INFERENCE_REQUEST_METHODS
      : options.surface === 'account'
        ? ACCOUNT_REQUEST_METHODS
        : P0_REQUEST_METHODS
  const requestedCodexHome = resolve(codexHome)
  await mkdir(requestedCodexHome, { recursive: true, mode: 0o700 })
  const normalizedCodexHome = await realpath(requestedCodexHome)
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'use-brian-codex-')))
  const stderr = createBoundedCapture(maxStderrBytes)

  let child: ChildProcessWithoutNullStreams | undefined
  let rpc: CodexRpcPeer | undefined
  let exited = false
  let closePromise: Promise<void> | undefined
  let removeAbortListener: (() => void) | undefined
  let resolveExit!: () => void
  const exitPromise = new Promise<void>((resolveExitPromise) => {
    resolveExit = resolveExitPromise
  })

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      removeAbortListener?.()
      rpc?.close(new CodexRpcClosedError('Codex app-server process closed'))
      child?.stdin.end()

      if (child && !exited) {
        const graceful = await waitForExit(exitPromise, shutdownTimeoutMs)
        if (!graceful && !exited) {
          child.kill('SIGTERM')
          const terminated = await waitForExit(exitPromise, shutdownTimeoutMs)
          if (!terminated && !exited) {
            child.kill('SIGKILL')
            await waitForExit(exitPromise, shutdownTimeoutMs)
          }
        }
      }

      await rm(cwd, { recursive: true, force: true })
    })()
    return closePromise
  }

  try {
    child = spawn(
      command.command,
      [
        ...(command.argsPrefix ?? []),
        'app-server',
        ...(options.surface === 'inference' ? CODEX_INFERENCE_HARDENING_ARGS : []),
        '--listen',
        'stdio://',
      ],
      {
        cwd,
        env: buildCodexEnvironment(normalizedCodexHome),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )

    child.stderr.on('data', stderr.append)
    child.once('error', (error) => {
      rpc?.close(new CodexRpcClosedError(`Codex app-server failed to start: ${error.message}`))
    })
    child.once('exit', (code, signal) => {
      exited = true
      resolveExit()
      rpc?.close(
        new CodexRpcClosedError(
          `Codex app-server exited (code=${code ?? 'none'}, signal=${signal ?? 'none'}; stderr redacted)`,
        ),
      )
    })

    rpc = new CodexRpcPeer({
      input: child.stdout,
      output: child.stdin,
      maxFrameBytes:
        options.maxFrameBytes ??
        (options.surface === 'inference' ? DEFAULT_INFERENCE_MAX_FRAME_BYTES : undefined),
      maxPendingRequests: options.maxPendingRequests,
      requestTimeoutMs: options.requestTimeoutMs,
      allowedRequestMethods,
      allowedNotificationMethods: P0_NOTIFICATION_METHODS,
    })

    if (options.signal) {
      const onAbort = () => void close()
      options.signal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort)
    }

    const initializeParams = InitializeParamsSchema.parse({
      clientInfo: {
        name: 'use_brian_oss',
        title: 'Use Brian OSS',
        version: options.clientVersion ?? '0.0.1',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
      },
    })
    const initialize = await rpc.request(
      'initialize',
      initializeParams,
      InitializeResponseSchema,
      { signal: options.signal },
    )

    if (resolve(initialize.codexHome) !== normalizedCodexHome) {
      throw new Error('Codex app-server initialized with an unexpected CODEX_HOME')
    }

    await rpc.notify('initialized', {})

    return {
      rpc,
      initialize,
      codexHome: normalizedCodexHome,
      cwd,
      pid: child.pid,
      diagnostics: stderr.diagnostics,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

function createBoundedCapture(maxBytes: number): {
  append(chunk: Buffer | string): void
  diagnostics(): CodexProcessDiagnostics
} {
  let bytes = 0
  let truncated = false
  return {
    append(chunk) {
      const chunkBytes = Buffer.byteLength(chunk)
      if (bytes >= maxBytes) {
        truncated = true
        return
      }
      const accepted = Math.min(chunkBytes, maxBytes - bytes)
      bytes += accepted
      if (accepted < chunkBytes) truncated = true
    },
    diagnostics() {
      return { stderrBytes: bytes, stderrTruncated: truncated }
    },
  }
}

async function waitForExit(exitPromise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolveWait) => {
    let settled = false
    const timeout = setTimeout(() => {
      settled = true
      resolveWait(false)
    }, timeoutMs)
    timeout.unref?.()
    void exitPromise.then(() => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolveWait(true)
    })
  })
}

function abortError(): Error {
  const error = new Error('Codex app-server start aborted')
  error.name = 'AbortError'
  return error
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolvedValue = value ?? fallback
  if (!Number.isSafeInteger(resolvedValue) || resolvedValue <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return resolvedValue
}
