/**
 * The ONLY module in the codebase allowed to import the E2B SDK (§4.3 —
 * graded by `pnpm check` `sandbox-provider-seam`). Everything above talks to
 * this thin runtime surface, so E2B Cloud → BYOC → self-host — or a swap to
 * a different sandbox vendor — never touches the orchestrator or tools.
 */
import { Sandbox } from 'e2b'

export type E2bCommandResult = { stdout: string; stderr: string; exitCode: number }

export type E2bSandboxHandle = {
  id: string
  runCommand(cmd: string, opts?: { timeoutMs?: number; envs?: Record<string, string> }): Promise<E2bCommandResult>
  writeFile(path: string, bytes: Uint8Array): Promise<void>
  readFile(path: string): Promise<Uint8Array>
  listDir(path: string): Promise<Array<{ name: string; path: string; isDir: boolean }>>
  pause(): Promise<void>
  kill(): Promise<void>
}

export type E2bCreateOptions = {
  templateId?: string
  /** Hard sandbox lifetime — E2B auto-kills at this timeout (the reaper backstop's floor). */
  timeoutMs?: number
  metadata?: Record<string, string>
  /**
   * Best-effort sandbox-level internet toggle. Browse sandboxes keep it on
   * (the browser must reach the target site); Python containment does NOT
   * rely on it — runPython always wraps in an unshared network namespace.
   */
  allowInternetAccess?: boolean
}

export type E2bRuntime = {
  create(opts: E2bCreateOptions): Promise<E2bSandboxHandle>
  connect(sandboxId: string): Promise<E2bSandboxHandle>
}

function wrap(sbx: Sandbox): E2bSandboxHandle {
  return {
    id: sbx.sandboxId,
    async runCommand(cmd, opts) {
      const res = await sbx.commands.run(cmd, {
        timeoutMs: opts?.timeoutMs,
        envs: opts?.envs,
      })
      return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode }
    },
    async writeFile(path, bytes) {
      await sbx.files.write(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    },
    async readFile(path) {
      const data = await sbx.files.read(path, { format: 'bytes' })
      return data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
    },
    async listDir(path) {
      const entries = await sbx.files.list(path)
      return entries.map((e) => ({
        name: e.name,
        path: e.path,
        isDir: String(e.type) === 'dir',
      }))
    },
    async pause() {
      // Pause is beta-gated across SDK minors (betaPause → pause). Feature-
      // detect; a sandbox that can't pause just stays running until kill —
      // costlier, never incorrect.
      const candidate = sbx as unknown as { betaPause?: () => Promise<unknown>; pause?: () => Promise<unknown> }
      if (typeof candidate.betaPause === 'function') {
        await candidate.betaPause()
      } else if (typeof candidate.pause === 'function') {
        await candidate.pause()
      }
    },
    async kill() {
      await sbx.kill()
    },
  }
}

export function createE2bRuntime(opts: { apiKey: string; defaultTemplateId?: string }): E2bRuntime {
  return {
    async create(createOpts) {
      const template = createOpts.templateId ?? opts.defaultTemplateId
      const sandboxOpts = {
        apiKey: opts.apiKey,
        timeoutMs: createOpts.timeoutMs,
        metadata: createOpts.metadata,
        // Passed through when the SDK minor supports it; ignored otherwise.
        allowInternetAccess: createOpts.allowInternetAccess,
      } as Parameters<typeof Sandbox.create>[1]
      const sbx = template
        ? await Sandbox.create(template, sandboxOpts)
        : await Sandbox.create(sandboxOpts)
      return wrap(sbx)
    },
    async connect(sandboxId) {
      // connect() resumes a paused sandbox transparently in SDK v2.
      const sbx = await Sandbox.connect(sandboxId, { apiKey: opts.apiKey })
      return wrap(sbx)
    },
  }
}
