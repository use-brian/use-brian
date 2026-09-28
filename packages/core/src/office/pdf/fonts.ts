import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import fontkit from '@cantoo/fontkit'
import type { PDFDocument, PDFFont } from '@cantoo/pdf-lib'
import { PdfEngineError } from './errors.js'

type FontPackage = 'noto-sans' | 'noto-sans-sc' | 'noto-sans-jp'

type UnicodeShard = {
  packageName: FontPackage
  key: string
  ranges: Array<readonly [number, number]>
}

export type PdfFontRun = {
  text: string
  font: PDFFont
  packageName: FontPackage
  shard: string
}

const require = createRequire(import.meta.url)
const shardCatalog = new Map<FontPackage, Promise<UnicodeShard[]>>()

function parseUnicodeRanges(value: string): Array<readonly [number, number]> {
  return value.split(',').map((token) => {
    const match = /^U\+([0-9a-f]+)(?:-([0-9a-f]+))?$/i.exec(token.trim())
    if (!match) throw new PdfEngineError('pdf_text_glyph_unsupported', 'A bundled font has an invalid Unicode-range declaration')
    return [Number.parseInt(match[1], 16), Number.parseInt(match[2] ?? match[1], 16)] as const
  })
}

async function loadShardCatalog(packageName: FontPackage): Promise<UnicodeShard[]> {
  let cached = shardCatalog.get(packageName)
  if (!cached) {
    cached = readFile(require.resolve(`@fontsource/${packageName}/unicode.json`), 'utf8').then((source) => {
      const unicode = JSON.parse(source) as Record<string, string>
      return Object.entries(unicode).map(([rawKey, ranges]) => ({
        packageName,
        key: rawKey.startsWith('[') ? rawKey.slice(1, -1) : rawKey,
        ranges: parseUnicodeRanges(ranges),
      }))
    })
    shardCatalog.set(packageName, cached)
  }
  return cached
}

function packageOrder(locale: string): FontPackage[] {
  const language = locale.toLowerCase().split(/[-_]/)[0]
  if (language === 'ja') return ['noto-sans-jp', 'noto-sans-sc', 'noto-sans']
  if (language === 'zh') return ['noto-sans-sc', 'noto-sans-jp', 'noto-sans']
  return ['noto-sans', 'noto-sans-jp', 'noto-sans-sc']
}

function covers(shard: UnicodeShard, codePoint: number): boolean {
  return shard.ranges.some(([start, end]) => codePoint >= start && codePoint <= end)
}

async function shardForCodePoint(codePoint: number, locale: string): Promise<UnicodeShard | null> {
  for (const packageName of packageOrder(locale)) {
    const shard = (await loadShardCatalog(packageName)).find((candidate) => covers(candidate, codePoint))
    if (shard) return shard
  }
  return null
}

function fontFilePath(shard: UnicodeShard): string {
  return require.resolve(`@fontsource/${shard.packageName}/files/${shard.packageName}-${shard.key}-400-normal.woff`)
}

/**
 * Selects only the Fontsource Unicode shards needed by `text`, embeds each as a
 * subset, and returns consecutive drawing runs. Selection is deterministic for
 * a locale and fails before drawing when any code point has no bundled glyph.
 */
export async function resolvePdfFontRuns(
  document: PDFDocument,
  text: string,
  locale: string,
): Promise<PdfFontRun[]> {
  if (!text) return []
  document.registerFontkit(fontkit)
  const selected: Array<{ text: string; shard: UnicodeShard }> = []
  for (const character of text) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined) continue
    const shard = await shardForCodePoint(codePoint, locale)
    if (!shard) {
      throw new PdfEngineError(
        'pdf_text_glyph_unsupported',
        `No bundled PDF font covers Unicode code point U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`,
      )
    }
    const previous = selected.at(-1)
    if (previous && previous.shard.packageName === shard.packageName && previous.shard.key === shard.key) {
      previous.text += character
    } else {
      selected.push({ text: character, shard })
    }
  }

  const embedded = new Map<string, PDFFont>()
  const runs: PdfFontRun[] = []
  for (const run of selected) {
    const key = `${run.shard.packageName}:${run.shard.key}`
    let font = embedded.get(key)
    if (!font) {
      const bytes = await readFile(fontFilePath(run.shard))
      font = await document.embedFont(bytes, { subset: true })
      embedded.set(key, font)
    }
    runs.push({ text: run.text, font, packageName: run.shard.packageName, shard: run.shard.key })
  }
  return runs
}
