import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { parseEpubToMarkdown } from '../epub.js'
import { parseEmlToMarkdown } from '../eml.js'
import { parseFileContent } from '../parsers.js'

// ── EPUB ──────────────────────────────────────────────────────────

type Chapter = { id: string; href: string; html: string }

async function epub(
  title: string,
  chapters: Chapter[],
  opts: { spine?: string[]; opfPath?: string; container?: boolean } = {},
): Promise<Buffer> {
  const opfPath = opts.opfPath ?? 'OEBPS/content.opf'
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  if (opts.container !== false) {
    zip.file(
      'META-INF/container.xml',
      `<container><rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    )
  }
  const spine = opts.spine ?? chapters.map((c) => c.id)
  zip.file(
    opfPath,
    `<package><metadata><dc:title>${title}</dc:title></metadata>
     <manifest>${chapters
       .map((c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`)
       .join('')}</manifest>
     <spine>${spine.map((id) => `<itemref idref="${id}"/>`).join('')}</spine></package>`,
  )
  const base = opfPath.split('/').slice(0, -1).join('/')
  for (const c of chapters) zip.file(base ? `${base}/${c.href}` : c.href, c.html)
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
}

const CH = (id: string, href: string, body: string): Chapter => ({
  id,
  href,
  html: `<html><head><title>${id}</title></head><body>${body}</body></html>`,
})

describe('[COMP:files/epub] parseEpubToMarkdown', () => {
  it('converts chapters through the shared HTML converter', async () => {
    const buf = await epub('Field Guide', [
      CH('one', 'c1.xhtml', '<h1>Chapter one</h1><p>Opening line.</p><style>p{color:red}</style>'),
    ])
    const { text, title, chapters } = await parseEpubToMarkdown(buf)
    expect(title).toBe('Field Guide')
    expect(chapters).toBe(1)
    expect(text).toContain('# Chapter one')
    expect(text).toContain('Opening line.')
    // The stylesheet is dropped for the same reason it is in an .html upload.
    expect(text).not.toContain('color:red')
  })

  /**
   * The reason the spine is read at all: an EPUB's parts are routinely named in
   * an order that has nothing to do with the reader's.
   */
  it('follows spine order, not filename order', async () => {
    const buf = await epub(
      'Ordered',
      [CH('b', 'part0034.xhtml', '<p>Second</p>'), CH('a', 'part0002.xhtml', '<p>First</p>')],
      { spine: ['b', 'a'] },
    )
    const { text } = await parseEpubToMarkdown(buf)
    expect(text.indexOf('Second')).toBeLessThan(text.indexOf('First'))
  })

  it('falls back to every XHTML part when the container is missing', async () => {
    const buf = await epub('Loose', [CH('one', 'c1.xhtml', '<p>Still readable.</p>')], {
      container: false,
    })
    expect((await parseEpubToMarkdown(buf)).text).toContain('Still readable.')
  })

  it('throws on a zip that is not an EPUB, so the caller can placeholder', async () => {
    const zip = new JSZip()
    zip.file('readme.txt', 'nope')
    const buf = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
    await expect(parseEpubToMarkdown(buf)).rejects.toThrow(/package document/)
  })
})

// ── EML ───────────────────────────────────────────────────────────

const PLAIN_EML = [
  'From: Dana Reyes <dana@example.com>',
  'To: ops@example.com',
  'Subject: Batch 1W07KPJ status',
  'Date: Wed, 05 Aug 2026 20:07:00 +0000',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Testing completed. The dossier is attached to the ticket.',
].join('\r\n')

describe('[COMP:files/eml] parseEmlToMarkdown', () => {
  it('renders the envelope as a header block above the body', async () => {
    const { text, subject } = await parseEmlToMarkdown(Buffer.from(PLAIN_EML))
    expect(subject).toBe('Batch 1W07KPJ status')
    expect(text).toContain('# Batch 1W07KPJ status')
    expect(text).toMatch(/\*\*From:\*\* "?Dana Reyes"? <dana@example\.com>/)
    expect(text).toContain('**To:** ops@example.com')
    expect(text).toContain('Testing completed.')
  })

  /**
   * The reason this uses mailparser rather than a hand-rolled walk: an
   * RFC 2047 encoded-word subject and a quoted-printable body are the ordinary
   * case, not the edge case.
   */
  it('decodes encoded-word headers and quoted-printable bodies', async () => {
    const eml = [
      'From: test@example.com',
      'Subject: =?utf-8?B?6LKh5YuZ5aCx5ZGK?=',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Caf=C3=A9 margin =3D 12%',
    ].join('\r\n')
    const { text, subject } = await parseEmlToMarkdown(Buffer.from(eml))
    expect(subject).toBe('財務報告')
    expect(text).toContain('Café margin = 12%')
  })

  /**
   * Prefers HTML over the plain part, inverting the IMAP connector's
   * precedence: this path chunks the message for retrieval, where headings and
   * tables are what make a segment findable.
   */
  it('converts the HTML alternative through the shared converter', async () => {
    const eml = [
      'From: test@example.com',
      'Subject: Rich only',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><head><style>b{color:red}</style></head><body><h2>Heading</h2><p>Body text.</p></body></html>',
    ].join('\r\n')
    const { text } = await parseEmlToMarkdown(Buffer.from(eml))
    expect(text).toContain('## Heading')
    expect(text).toContain('Body text.')
    expect(text).not.toContain('color:red')
  })

  it('names attachments without claiming to have read them', async () => {
    const eml = [
      'From: test@example.com',
      'Subject: With attachment',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain',
      '',
      'See attached.',
      '--b1',
      'Content-Type: application/pdf; name="dossier.pdf"',
      'Content-Disposition: attachment; filename="dossier.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('%PDF-1.4 fake').toString('base64'),
      '--b1--',
    ].join('\r\n')
    const { text, attachments } = await parseEmlToMarkdown(Buffer.from(eml))
    expect(attachments).toEqual(['dossier.pdf'])
    expect(text).toContain('**Attachments (not extracted):** dossier.pdf (application/pdf')
    expect(text).toContain('See attached.')
  })

  it('reports no text for an envelope with no body, rather than indexing headers', async () => {
    const eml = ['From: test@example.com', 'Subject: Empty', '', ''].join('\r\n')
    expect((await parseEmlToMarkdown(Buffer.from(eml))).text).toBe('')
  })
})

// ── Routing ───────────────────────────────────────────────────────

describe('[COMP:files/parsers] EPUB and EML routing', () => {
  it('routes an .epub by mime and by extension', async () => {
    const buf = await epub('Guide', [CH('one', 'c1.xhtml', '<p>Readable.</p>')])
    const byMime = await parseFileContent(buf, 'application/epub+zip', 'g.epub')
    expect(byMime.summary).toContain('Book: g.epub')
    expect(byMime.text).toContain('Readable.')

    const byExt = await parseFileContent(buf, 'application/octet-stream', 'G.EPUB')
    expect(byExt.text).toContain('Readable.')
  })

  it('routes an .eml by mime and by extension', async () => {
    const byMime = await parseFileContent(Buffer.from(PLAIN_EML), 'message/rfc822', 'note.eml')
    expect(byMime.placeholder).toBeUndefined()
    expect(byMime.summary).toContain('Email: Batch 1W07KPJ status')

    const byExt = await parseFileContent(Buffer.from(PLAIN_EML), '', 'NOTE.EML')
    expect(byExt.text).toContain('Testing completed.')
  })

  it('placeholders an unreadable EPUB instead of storing garbage', async () => {
    const { text, placeholder } = await parseFileContent(
      Buffer.from('not a zip'),
      'application/epub+zip',
      'broken.epub',
    )
    expect(placeholder).toBe(true)
    expect(text).toContain('Could not parse as EPUB')
  })

  it('placeholders an email with attachments but no body', async () => {
    const eml = ['From: t@example.com', 'Subject: none', '', ''].join('\r\n')
    const { placeholder, text } = await parseFileContent(Buffer.from(eml), 'message/rfc822', 'x.eml')
    expect(placeholder).toBe(true)
    expect(text).toContain('No extractable body')
  })
})
