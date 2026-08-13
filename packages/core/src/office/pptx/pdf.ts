/** Canonical Presentation PDF release through isolated LibreOffice. [COMP:office/presentation-pdf] */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PresentationSnapshot } from '@use-brian/office-model'
import type { OfficeResourceResolver } from '../package.js'
import { exportOfficePresentation } from './index.js'

export type PresentationPdfIssueCode = 'converter_unavailable' | 'timeout' | 'invalid_pdf' | 'page_count_mismatch'
export type PresentationPdfIssue = { severity: 'error'; code: PresentationPdfIssueCode; message: string }
export type PresentationPdfReceipt = {
  expectedPageCount: number
  actualPageCount?: number
  renderer: 'libreoffice'
  issues: PresentationPdfIssue[]
}
export type PresentationPdfPort = {
  convert(pptx: Uint8Array): Promise<Uint8Array>
  pageCount(pdf: Uint8Array): Promise<number>
}

class PresentationPdfFailure extends Error {
  constructor(readonly code: PresentationPdfIssueCode) { super(code) }
}

async function libreOfficeBinary(): Promise<string> {
  const configured = process.env.LIBREOFFICE_BIN?.trim()
  if (configured) return configured
  const candidates = ['/Applications/LibreOffice.app/Contents/MacOS/soffice', '/usr/bin/libreoffice', '/usr/local/bin/libreoffice']
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate } catch { /* continue */ }
  }
  return 'soffice'
}

export async function convertPresentationPptxToPdf(
  input: Uint8Array,
  run: (params: { binary: string; inputPath: string; outputDirectory: string; profileDirectory: string }) => Promise<void> = runLibreOffice,
): Promise<Uint8Array> {
  const root = await mkdtemp(join(tmpdir(), 'brian-presentation-pdf-'))
  try {
    const inputDirectory = join(root, 'input')
    const outputDirectory = join(root, 'output')
    const profileDirectory = join(root, 'profile')
    await Promise.all([mkdir(inputDirectory), mkdir(outputDirectory), mkdir(profileDirectory)])
    const inputPath = join(inputDirectory, 'presentation.pptx')
    await writeFile(inputPath, input)
    await run({ binary: await libreOfficeBinary(), inputPath, outputDirectory, profileDirectory })
    try {
      return new Uint8Array(await readFile(join(outputDirectory, 'presentation.pdf')))
    } catch {
      throw new PresentationPdfFailure('invalid_pdf')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function runLibreOffice(params: { binary: string; inputPath: string; outputDirectory: string; profileDirectory: string }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(params.binary, [`-env:UserInstallation=${pathToFileURL(params.profileDirectory).href}`, '--headless', '--convert-to', 'pdf', '--outdir', params.outputDirectory, params.inputPath], { stdio: 'ignore' })
    let settled = false
    const finish = (failure?: PresentationPdfFailure) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      failure ? reject(failure) : resolve()
    }
    const timeout = setTimeout(() => { child.kill('SIGKILL'); finish(new PresentationPdfFailure('timeout')) }, 60_000)
    child.once('error', () => finish(new PresentationPdfFailure('converter_unavailable')))
    child.once('exit', (code) => finish(code === 0 ? undefined : new PresentationPdfFailure('converter_unavailable')))
  })
}

async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  try {
    const task = getDocument({ data: bytes.slice() })
    const document = await task.promise
    try { return document.numPages } finally { await document.destroy() }
  } catch {
    throw new PresentationPdfFailure('invalid_pdf')
  }
}

export const defaultPresentationPdfPort: PresentationPdfPort = { convert: convertPresentationPptxToPdf, pageCount: pdfPageCount }

const MESSAGES: Record<PresentationPdfIssueCode, string> = {
  converter_unavailable: 'Presentation PDF conversion is unavailable.',
  timeout: 'Presentation PDF conversion timed out.',
  invalid_pdf: 'Presentation PDF conversion produced an invalid PDF.',
  page_count_mismatch: 'Presentation PDF page count does not match the slide count.',
}

export async function exportOfficePresentationPdf(
  snapshot: PresentationSnapshot,
  resolveResource: OfficeResourceResolver = async () => null,
  port: PresentationPdfPort = defaultPresentationPdfPort,
): Promise<{ bytes?: Uint8Array; mime: 'application/pdf'; receipt: PresentationPdfReceipt }> {
  const expectedPageCount = snapshot.slides.length
  const base = { expectedPageCount, renderer: 'libreoffice' as const, issues: [] as PresentationPdfIssue[] }
  // PPTX export is its own canonical validation boundary. Do not mislabel a
  // missing resource or model failure as a converter outage.
  const pptx = await exportOfficePresentation(snapshot, resolveResource)
  try {
    const bytes = await port.convert(pptx.bytes)
    let actualPageCount: number
    try { actualPageCount = await port.pageCount(bytes) } catch { throw new PresentationPdfFailure('invalid_pdf') }
    if (actualPageCount !== expectedPageCount) {
      return { mime: 'application/pdf', receipt: { ...base, actualPageCount, issues: [{ severity: 'error', code: 'page_count_mismatch', message: MESSAGES.page_count_mismatch }] } }
    }
    return { bytes, mime: 'application/pdf', receipt: { ...base, actualPageCount } }
  } catch (error) {
    const code: PresentationPdfIssueCode = error instanceof PresentationPdfFailure
      ? error.code
      : error instanceof Error && (error.message === 'timeout' || error.message === 'converter_unavailable' || error.message === 'invalid_pdf')
        ? error.message
        : 'converter_unavailable'
    return { mime: 'application/pdf', receipt: { ...base, issues: [{ severity: 'error', code, message: MESSAGES[code] }] } }
  }
}
