/**
 * Shared headless-LibreOffice PDF renderer. [COMP:files/libreoffice]
 *
 * ONE place that knows how to turn an Office document (DOCX / PPTX / XLSX)
 * into PDF bytes with LibreOffice. Every PDF Brian produces goes through it:
 * the three Office release paths (`office/docx/pdf.ts`, `office/pptx/pdf.ts`,
 * `office/xlsx/pdf.ts`) and the doc-page / Markdown spoke
 * (`doc/convert/to-pdf.ts`, which backs the `renderPdf` chat tool and
 * `GET /api/views/:id/export?format=pdf`).
 *
 * Why one runner: the binary lookup, the isolated per-run profile directory,
 * the timeout, the vendor-output policy and the concurrency cap are
 * deployment facts, not per-format facts. Before this module each Office
 * family carried its own copy of the spawn code, and none of them was
 * installed anywhere — the hosted `apps/api/Dockerfile` and the OSS
 * `deploy-brian` provisioner shipped `ffmpeg` but no `soffice`, so every PDF
 * release failed `converter_unavailable` in production while unit tests
 * (which inject a fake runner) stayed green. The runtime prerequisite is now
 * graded by `pnpm check` (`invariants/runtime-binaries`).
 *
 * Contract:
 * - Every run gets a fresh `mkdtemp` root with `input/`, `output/` and a
 *   private `-env:UserInstallation` profile, removed in `finally`. Two
 *   concurrent conversions can never share a LibreOffice profile lock.
 * - Vendor output (stderr) never reaches a user: failures are typed
 *   `LibreOfficeError`s whose `code` is ours; the tail of stderr rides on
 *   `cause` for server-side logs only.
 * - At most `LIBREOFFICE_MAX_CONCURRENCY` (default 2) conversions run at
 *   once per process. A headless soffice peaks at a few hundred MB, and the
 *   API container is 2 GiB, so an unbounded fan-out (a workflow rendering ten
 *   PDFs) would OOM the instance instead of queueing.
 * - `LIBREOFFICE_BIN` overrides the binary; otherwise the well-known install
 *   paths are probed and `soffice` on PATH is the last resort.
 *
 * Spec: docs/architecture/features/doc-conversion.md → "PDF spoke" and
 * docs/architecture/platform/deployment.md → "LibreOffice".
 */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { probePdfPageCount } from './pdf-pages.js'

export type LibreOfficeFailureCode = 'converter_unavailable' | 'timeout' | 'invalid_pdf'

/** Typed failure — `code` is Brian-owned; `message` is user-safe. */
export class LibreOfficeError extends Error {
  constructor(
    readonly code: LibreOfficeFailureCode,
    options?: { cause?: unknown },
  ) {
    super(code, options)
    this.name = 'LibreOfficeError'
  }
}

export const LIBREOFFICE_FAILURE_MESSAGES: Record<LibreOfficeFailureCode, string> = {
  converter_unavailable: 'PDF rendering is unavailable on this deployment (LibreOffice is not installed or failed to start).',
  timeout: 'PDF rendering timed out.',
  invalid_pdf: 'PDF rendering did not produce a readable PDF.',
}

export type LibreOfficeRunParams = {
  binary: string
  inputPath: string
  outputDirectory: string
  profileDirectory: string
}
/** The spawn seam — tests inject a fake; production uses `runLibreOffice`. */
export type LibreOfficeRun = (params: LibreOfficeRunParams) => Promise<void>

export const LIBREOFFICE_TIMEOUT_MS = 60_000
const DEFAULT_MAX_CONCURRENCY = 2
const STDERR_TAIL_CHARS = 2_000

/** Well-known install locations, probed in order; `soffice` on PATH is the fallback. */
const BINARY_CANDIDATES = [
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/usr/bin/libreoffice',
  '/usr/bin/soffice',
  '/usr/local/bin/libreoffice',
  '/usr/local/bin/soffice',
  '/opt/homebrew/bin/soffice',
]

export async function libreOfficeBinary(): Promise<string> {
  const configured = process.env.LIBREOFFICE_BIN?.trim()
  if (configured) return configured
  for (const candidate of BINARY_CANDIDATES) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      /* keep looking */
    }
  }
  return 'soffice'
}

/** Cheap availability probe: is a LibreOffice binary resolvable without spawning it?
 *  A bare `soffice` PATH fallback counts as unknown (true) — the spawn decides. */
export async function isLibreOfficeConfigured(): Promise<boolean> {
  const binary = await libreOfficeBinary()
  if (binary === 'soffice') return await onPath('soffice')
  try {
    await access(binary, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function onPath(name: string): Promise<boolean> {
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  for (const dir of dirs) {
    try {
      await access(join(dir, name), constants.X_OK)
      return true
    } catch {
      /* next */
    }
  }
  return false
}

export function libreOfficeMaxConcurrency(): number {
  const raw = Number.parseInt(process.env.LIBREOFFICE_MAX_CONCURRENCY ?? '', 10)
  return Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_MAX_CONCURRENCY
}

// ── In-process semaphore ─────────────────────────────────────────────
let active = 0
const waiters: Array<() => void> = []

async function acquire(): Promise<() => void> {
  if (active < libreOfficeMaxConcurrency()) {
    active += 1
  } else {
    await new Promise<void>((resolve) => waiters.push(resolve))
    active += 1
  }
  let released = false
  return () => {
    if (released) return
    released = true
    active -= 1
    waiters.shift()?.()
  }
}

/** Test/observability hook: how many conversions are running right now. */
export function libreOfficeActiveConversions(): number {
  return active
}

/**
 * Production spawn: `soffice --headless --convert-to pdf --outdir <out> <in>`
 * with a private user profile. Rejects with a typed `LibreOfficeError`.
 */
export const runLibreOffice: LibreOfficeRun = async (params) => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      params.binary,
      [
        `-env:UserInstallation=${pathToFileURL(params.profileDirectory).href}`,
        '--headless',
        '--norestore',
        '--nolockcheck',
        '--convert-to',
        'pdf',
        '--outdir',
        params.outputDirectory,
        params.inputPath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-STDERR_TAIL_CHARS)
    })
    let settled = false
    const finish = (failure?: LibreOfficeError) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      failure ? reject(failure) : resolve()
    }
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new LibreOfficeError('timeout', { cause: stderr || undefined }))
    }, LIBREOFFICE_TIMEOUT_MS)
    child.once('error', (error) => finish(new LibreOfficeError('converter_unavailable', { cause: error })))
    child.once('exit', (code) =>
      finish(code === 0 ? undefined : new LibreOfficeError('converter_unavailable', { cause: stderr || `exit ${code}` })),
    )
  })
}

/**
 * Convert one Office document to PDF bytes inside an isolated temp root.
 * `inputName` fixes the extension LibreOffice sniffs the format from
 * (`document.docx`, `presentation.pptx`, `workbook.xlsx`); the output is
 * `<basename>.pdf` in `output/`.
 */
export async function convertToPdfWithLibreOffice(
  input: Uint8Array,
  opts: { inputName: string; run?: LibreOfficeRun; tempPrefix?: string },
): Promise<Uint8Array> {
  const run = opts.run ?? runLibreOffice
  const root = await mkdtemp(join(tmpdir(), opts.tempPrefix ?? 'brian-pdf-'))
  const release = await acquire()
  try {
    const inputDirectory = join(root, 'input')
    const outputDirectory = join(root, 'output')
    const profileDirectory = join(root, 'profile')
    await Promise.all([mkdir(inputDirectory), mkdir(outputDirectory), mkdir(profileDirectory)])
    const inputPath = join(inputDirectory, opts.inputName)
    await writeFile(inputPath, input)
    await run({ binary: await libreOfficeBinary(), inputPath, outputDirectory, profileDirectory })
    const outputPath = join(outputDirectory, `${basename(opts.inputName, extname(opts.inputName))}.pdf`)
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await readFile(outputPath))
    } catch (error) {
      throw new LibreOfficeError('invalid_pdf', { cause: error })
    }
    if (bytes.length === 0) throw new LibreOfficeError('invalid_pdf')
    return bytes
  } finally {
    release()
    await rm(root, { recursive: true, force: true })
  }
}

/** Page count of rendered bytes; throws `invalid_pdf` when they do not parse. */
export async function renderedPdfPageCount(bytes: Uint8Array): Promise<number> {
  const count = await probePdfPageCount(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  if (count === null) throw new LibreOfficeError('invalid_pdf')
  return count
}

/** Narrow an arbitrary thrown value to a LibreOffice failure code (default `converter_unavailable`). */
export function libreOfficeFailureCode(error: unknown): LibreOfficeFailureCode {
  if (error instanceof LibreOfficeError) return error.code
  if (error instanceof Error && (error.message === 'timeout' || error.message === 'converter_unavailable' || error.message === 'invalid_pdf')) {
    return error.message
  }
  return 'converter_unavailable'
}
