/**
 * Isolated compute + file-bridge tools (spec §3, §5; plan §4.7, §4.12):
 *
 *  - `runPython` — computation ONLY, in the task sandbox's interpreter:
 *    egress-denied by provider construction (unshare, fail-closed), no
 *    browser handle, no tool access, no ambient secrets. Paid plans only.
 *  - `loadFromWorkspace` / `saveToWorkspace` — the explicit file-bridge.
 *    Workspace-scoped BY CONSTRUCTION: the workspace comes from ToolContext,
 *    never from model input, and all bytes flow through the injected files
 *    port (FilesApi → RLS) — a workspace-W task cannot touch workspace-V
 *    files because no code path ever sees another workspace id.
 *
 * Same governance rails as the browser tools: autonomous-path hard block
 * (Barrier 2), L1/L2 policy, metadata-only audit events.
 */
import { z } from 'zod'
import { buildTool, type Tool, type ToolContext, type ToolResult } from '../tools/types.js'
import { isAutonomousToolContext } from '../tools/capability-gate.js'
import type { SandboxTaskBinding } from './cloud-browser-provider.js'
import type { SandboxProvider } from './types.js'
import type { ComputerToolPolicy, ResolveComputerToolPolicy } from './tools.js'

export type ComputeToolEvent = {
  type: 'python_run' | 'bridge_load' | 'bridge_save'
  ok: boolean
  /** python: exit code; bridge: byte count. Metadata only — never content. */
  detail?: number
}

/** Workspace-scoped byte I/O — boot backs this with FilesApi (RLS inside). */
export type SandboxFilesPort = {
  readBytes(
    ctx: { userId: string; workspaceId: string },
    fileIdOrPath: string,
  ): Promise<{ bytes: Uint8Array; name: string } | null>
  writeBytes(
    ctx: { userId: string; workspaceId: string },
    params: { path: string; bytes: Uint8Array; title?: string },
  ): Promise<{ fileId: string; path: string }>
}

export type CreateComputeToolsOptions = {
  provider: SandboxProvider | null
  binding: SandboxTaskBinding | null
  files: SandboxFilesPort | null
  /** Paid-plan gate (§4.7): 'free' → runPython refuses. */
  getWorkspacePlan: (workspaceId: string) => Promise<string>
  resolvePolicy?: ResolveComputerToolPolicy
  onEvent?: (event: ComputeToolEvent, context: ToolContext) => void
  /** Barrier 2 — same switch as the browser tools. */
  unattendedEnabled?: () => boolean
}

const PYTHON_MAX_CODE_CHARS = 60_000
const PYTHON_TIMEOUT_MS = 60_000
const BRIDGE_MAX_BYTES = 50 * 1024 * 1024
const OUTPUT_CAP_CHARS = 16_000

export function createComputeTools(opts: CreateComputeToolsOptions): {
  runPython: Tool
  loadFromWorkspace: Tool
  saveToWorkspace: Tool
} {
  const unattendedEnabled = opts.unattendedEnabled ?? (() => false)

  /** Barrier 2 + R2-8: unattended needs live metering AND a paid plan. */
  async function autonomousGate(context: ToolContext): Promise<ToolResult | null> {
    if (!isAutonomousToolContext(context)) return null
    if (!unattendedEnabled()) {
      return {
        data: 'ERROR: Computer tools are unavailable on autonomous runs; ask the user to run this from chat.',
        isError: true,
      }
    }
    const plan = context.workspaceId
      ? await opts.getWorkspacePlan(context.workspaceId).catch(() => 'free')
      : 'free'
    if (plan === 'free') {
      return {
        data: 'ERROR: Unattended computer use is available on paid plans only. The user can upgrade the workspace plan, or run this from chat.',
        isError: true,
      }
    }
    return null
  }

  function workspaceGate(context: ToolContext): ToolResult | null {
    if (context.workspaceId) return null
    return {
      data: 'ERROR: Computer tools require a workspace-scoped chat.',
      isError: true,
    }
  }

  async function policyGate(toolName: string, context: ToolContext): Promise<ToolResult | null> {
    if (!opts.resolvePolicy) return null
    try {
      const policy: ComputerToolPolicy = await opts.resolvePolicy(toolName, {
        userId: context.userId,
        assistantId: context.assistantId,
      })
      if (policy === 'block') {
        return {
          data: `ERROR: "${toolName}" is blocked by tool policy for this assistant. A workspace member can change it under Studio > Connectors > Computer.`,
          isError: true,
        }
      }
    } catch {
      return null
    }
    return null
  }

  function policyAsk(toolName: string): (context: ToolContext) => Promise<boolean> {
    return async (context) => {
      if (!opts.resolvePolicy) return false
      try {
        return (
          (await opts.resolvePolicy(toolName, {
            userId: context.userId,
            assistantId: context.assistantId,
          })) === 'ask'
        )
      } catch {
        return false
      }
    }
  }

  async function sandboxFor(context: ToolContext): Promise<{ sandboxId: string }> {
    if (!opts.provider || !opts.binding) {
      throw new Error('The cloud sandbox is not configured on this deployment, so Python and the file bridge are unavailable.')
    }
    return opts.binding.resolve({
      userId: context.userId,
      workspaceId: context.workspaceId ?? '',
      sessionId: context.sessionId,
    })
  }

  function emit(event: ComputeToolEvent, context: ToolContext): void {
    try {
      opts.onEvent?.(event, context)
    } catch {
      /* audit must never break the tool */
    }
  }

  function cap(text: string): string {
    return text.length > OUTPUT_CAP_CHARS ? `${text.slice(0, OUTPUT_CAP_CHARS)}\n…(truncated)` : text
  }

  // ── runPython (§4.7) ─────────────────────────────────────────

  const runPython = buildTool({
    name: 'runPython',
    description:
      'Run a Python snippet in the task sandbox for computation: parse, transform, analyze, or build data artifacts over files already in the sandbox scratch (see loadFromWorkspace). Common data libraries are pre-installed. The interpreter has NO network access and cannot drive the browser or call tools — bring data in with loadFromWorkspace and persist results with saveToWorkspace.',
    inputSchema: z.object({
      code: z.string().min(1).max(PYTHON_MAX_CODE_CHARS).describe('Python source to execute'),
    }),
    isReadOnly: false,
    isConcurrencySafe: false,
    requiresConfirmation: false,
    resolveConfirmation: policyAsk('runPython'),
    timeoutMs: PYTHON_TIMEOUT_MS + 15_000,
    maxResultSizeChars: OUTPUT_CAP_CHARS * 2,
    async execute(input, context) {
      const gate = (await autonomousGate(context)) ?? workspaceGate(context) ?? (await policyGate('runPython', context))
      if (gate) return gate
      // Paid gate (§4.7): default-on for paid plans, off for free.
      const plan = await opts.getWorkspacePlan(context.workspaceId as string).catch(() => 'free')
      if (plan === 'free') {
        return {
          data: 'ERROR: Python execution is available on paid plans only. The user can upgrade the workspace plan to enable it.',
          isError: true,
        }
      }
      try {
        const { sandboxId } = await sandboxFor(context)
        const result = await opts.provider!.runPython(sandboxId, {
          code: input.code,
          timeoutMs: PYTHON_TIMEOUT_MS,
        })
        emit({ type: 'python_run', ok: result.exitCode === 0, detail: result.exitCode }, context)
        const body =
          `exit code: ${result.exitCode}\n` +
          (result.stdout ? `stdout:\n${cap(result.stdout)}\n` : '') +
          (result.stderr ? `stderr:\n${cap(result.stderr)}` : '')
        return { data: body.trim() || 'exit code: 0 (no output)', isError: result.exitCode !== 0 }
      } catch (err) {
        emit({ type: 'python_run', ok: false }, context)
        return { data: `ERROR: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  // ── loadFromWorkspace (§4.12) ────────────────────────────────

  const loadFromWorkspace = buildTool({
    name: 'loadFromWorkspace',
    description:
      'Copy a workspace file into the task sandbox scratch so runPython can read it. Pass the workspace file id or path; returns the scratch path to use in Python.',
    inputSchema: z.object({
      file: z.string().min(1).max(1024).describe('Workspace file id or path'),
    }),
    isReadOnly: true,
    isConcurrencySafe: false,
    requiresConfirmation: false,
    resolveConfirmation: policyAsk('loadFromWorkspace'),
    timeoutMs: 60_000,
    async execute(input, context) {
      const gate = (await autonomousGate(context)) ?? workspaceGate(context) ?? (await policyGate('loadFromWorkspace', context))
      if (gate) return gate
      if (!opts.files) {
        return { data: 'ERROR: Workspace file storage is not configured on this deployment.', isError: true }
      }
      try {
        // Workspace scoping (§4.12): identity comes from the ToolContext
        // ONLY — there is no workspace parameter for the model to supply.
        const file = await opts.files.readBytes(
          { userId: context.userId, workspaceId: context.workspaceId as string },
          input.file,
        )
        if (!file) {
          return { data: `ERROR: No workspace file matches "${input.file}".`, isError: true }
        }
        if (file.bytes.byteLength > BRIDGE_MAX_BYTES) {
          return { data: 'ERROR: That file is too large for the sandbox bridge (50 MB cap).', isError: true }
        }
        const { sandboxId } = await sandboxFor(context)
        const scratchName = file.name.replace(/[^\w.-]+/g, '_')
        const { path } = await opts.provider!.bridge.load(sandboxId, {
          path: scratchName,
          bytes: file.bytes,
        })
        emit({ type: 'bridge_load', ok: true, detail: file.bytes.byteLength }, context)
        return { data: `Loaded ${file.name} (${file.bytes.byteLength} bytes) into the sandbox at ${path}.` }
      } catch (err) {
        emit({ type: 'bridge_load', ok: false }, context)
        return { data: `ERROR: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  // ── saveToWorkspace (§4.12) ──────────────────────────────────

  const saveToWorkspace = buildTool({
    name: 'saveToWorkspace',
    description:
      'Persist a file from the task sandbox scratch into the workspace files (the durable store — the sandbox is disposable). Pass the scratch path runPython wrote.',
    inputSchema: z.object({
      path: z.string().min(1).max(1024).describe('Sandbox scratch path to save'),
      title: z.string().max(200).optional().describe('Optional workspace file title'),
    }),
    isReadOnly: false,
    isConcurrencySafe: false,
    requiresConfirmation: true,
    // Dynamic policy overrides the static flag ONLY when boot wired a
    // resolver (the files-tools semantics): default 'ask' keeps the confirm,
    // an explicit workspace 'allow' waives it, and with no resolver at all
    // (OSS/tests) the static confirm stands.
    resolveConfirmation: async (context) =>
      opts.resolvePolicy ? policyAsk('saveToWorkspace')(context) : true,
    timeoutMs: 60_000,
    async execute(input, context) {
      const gate = (await autonomousGate(context)) ?? workspaceGate(context) ?? (await policyGate('saveToWorkspace', context))
      if (gate) return gate
      if (!opts.files) {
        return { data: 'ERROR: Workspace file storage is not configured on this deployment.', isError: true }
      }
      try {
        const { sandboxId } = await sandboxFor(context)
        const { bytes } = await opts.provider!.bridge.save(sandboxId, { path: input.path })
        if (bytes.byteLength > BRIDGE_MAX_BYTES) {
          return { data: 'ERROR: That file is too large for the sandbox bridge (50 MB cap).', isError: true }
        }
        const name = input.path.split('/').pop() || 'artifact'
        const saved = await opts.files.writeBytes(
          { userId: context.userId, workspaceId: context.workspaceId as string },
          {
            path: `computer/artifacts/${Date.now()}-${name.replace(/[^\w.-]+/g, '_')}`,
            bytes,
            title: input.title ?? name,
          },
        )
        emit({ type: 'bridge_save', ok: true, detail: bytes.byteLength }, context)
        return { data: `Saved ${name} (${bytes.byteLength} bytes) to workspace files at ${saved.path} (id ${saved.fileId}).` }
      } catch (err) {
        emit({ type: 'bridge_save', ok: false }, context)
        return { data: `ERROR: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  return { runPython, loadFromWorkspace, saveToWorkspace }
}
