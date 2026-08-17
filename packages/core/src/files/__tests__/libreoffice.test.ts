import { describe, it, expect, afterEach } from 'vitest'
import { access, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  LibreOfficeError,
  convertToPdfWithLibreOffice,
  libreOfficeActiveConversions,
  libreOfficeBinary,
  libreOfficeFailureCode,
  libreOfficeMaxConcurrency,
  renderedPdfPageCount,
  type LibreOfficeRunParams,
} from '../libreoffice.js'

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46])

afterEach(() => {
  delete process.env.LIBREOFFICE_BIN
  delete process.env.LIBREOFFICE_MAX_CONCURRENCY
})

describe('[COMP:files/libreoffice] shared LibreOffice PDF runner', () => {
  it('writes the input under the requested name and returns <stem>.pdf from output/', async () => {
    let seen: LibreOfficeRunParams | null = null
    const bytes = await convertToPdfWithLibreOffice(new Uint8Array([1, 2, 3]), {
      inputName: 'workbook.xlsx',
      async run(params) {
        seen = params
        const input = await access(params.inputPath).then(() => true, () => false)
        expect(input).toBe(true)
        await writeFile(join(params.outputDirectory, 'workbook.pdf'), PDF_MAGIC)
      },
    })
    expect(Array.from(bytes)).toEqual(Array.from(PDF_MAGIC))
    expect(seen).not.toBeNull()
    expect(seen!.inputPath.endsWith('/input/workbook.xlsx')).toBe(true)
    expect(seen!.profileDirectory.endsWith('/profile')).toBe(true)
    // Isolated root is removed afterwards — nothing leaks between runs.
    await expect(access(dirname(dirname(seen!.inputPath)))).rejects.toThrow()
  })

  it('maps a converter that produced no PDF to invalid_pdf and still cleans up', async () => {
    let root = ''
    await expect(
      convertToPdfWithLibreOffice(new Uint8Array([1]), {
        inputName: 'document.docx',
        async run({ inputPath }) {
          root = dirname(dirname(inputPath))
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_pdf' })
    await expect(access(root)).rejects.toThrow()
  })

  it('maps an empty output file to invalid_pdf', async () => {
    await expect(
      convertToPdfWithLibreOffice(new Uint8Array([1]), {
        inputName: 'document.docx',
        async run({ outputDirectory }) {
          await writeFile(join(outputDirectory, 'document.pdf'), new Uint8Array())
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_pdf' })
  })

  it('propagates typed runner failures unchanged and never leaks vendor text into message', async () => {
    const err = await convertToPdfWithLibreOffice(new Uint8Array([1]), {
      inputName: 'document.docx',
      async run() {
        throw new LibreOfficeError('converter_unavailable', { cause: 'ERROR: soffice: command not found' })
      },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LibreOfficeError)
    expect((err as LibreOfficeError).code).toBe('converter_unavailable')
    expect((err as LibreOfficeError).message).toBe('converter_unavailable')
    expect((err as LibreOfficeError).cause).toContain('soffice')
  })

  it('caps concurrent conversions at LIBREOFFICE_MAX_CONCURRENCY and queues the rest', async () => {
    process.env.LIBREOFFICE_MAX_CONCURRENCY = '1'
    expect(libreOfficeMaxConcurrency()).toBe(1)
    let peak = 0
    let inFlight = 0
    const run = async ({ outputDirectory }: LibreOfficeRunParams) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 15))
      inFlight -= 1
      await writeFile(join(outputDirectory, 'document.pdf'), PDF_MAGIC)
    }
    await Promise.all(
      Array.from({ length: 4 }, () => convertToPdfWithLibreOffice(new Uint8Array([1]), { inputName: 'document.docx', run })),
    )
    expect(peak).toBe(1)
    expect(libreOfficeActiveConversions()).toBe(0)
  })

  it('releases the slot when the runner throws (no permanent starvation)', async () => {
    process.env.LIBREOFFICE_MAX_CONCURRENCY = '1'
    await expect(
      convertToPdfWithLibreOffice(new Uint8Array([1]), {
        inputName: 'document.docx',
        async run() {
          throw new LibreOfficeError('timeout')
        },
      }),
    ).rejects.toMatchObject({ code: 'timeout' })
    expect(libreOfficeActiveConversions()).toBe(0)
    // A follow-up conversion must not hang.
    const bytes = await convertToPdfWithLibreOffice(new Uint8Array([1]), {
      inputName: 'document.docx',
      async run({ outputDirectory }) {
        await writeFile(join(outputDirectory, 'document.pdf'), PDF_MAGIC)
      },
    })
    expect(bytes.length).toBe(4)
  })

  it('honours LIBREOFFICE_BIN before any probed path', async () => {
    process.env.LIBREOFFICE_BIN = '/opt/custom/soffice'
    expect(await libreOfficeBinary()).toBe('/opt/custom/soffice')
  })

  it('narrows unknown throwables to converter_unavailable', () => {
    expect(libreOfficeFailureCode(new Error('boom'))).toBe('converter_unavailable')
    expect(libreOfficeFailureCode(new Error('timeout'))).toBe('timeout')
    expect(libreOfficeFailureCode(new LibreOfficeError('invalid_pdf'))).toBe('invalid_pdf')
  })

  it('reports invalid_pdf for bytes that are not a PDF', async () => {
    await expect(renderedPdfPageCount(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ code: 'invalid_pdf' })
  })
})
