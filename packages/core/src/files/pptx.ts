/**
 * PowerPoint (.pptx) → Markdown — the deterministic *text* track.
 *
 * A .pptx is a zip of Office Open XML. We unzip (JSZip) and walk the slide XML
 * to pull slide text + speaker notes, one `## Slide N` section each, in true
 * display order (resolved via `presentation.xml`'s `sldIdLst`, not filename
 * order). This is born-digital text, extracted with no model call.
 *
 * It does NOT capture the visual content of a deck (charts, diagrams, layout) —
 * that needs the vision track (render each slide → image, or .pptx → PDF →
 * native multimodal), which carries a LibreOffice dependency and is a deploy
 * decision, not a parsing one. See docs/architecture/engine/file-handling.md.
 */
import JSZip from 'jszip'

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&') // must be last
}

// Join <a:t> text runs, grouped by <a:p> paragraphs (one line each). Auto
// fields (slide numbers, dates) are dropped so they don't pollute the text.
function textFromXml(xml: string): string {
  const clean = xml.replace(/<a:fld\b[\s\S]*?<\/a:fld>/g, '')
  return (clean.match(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g) ?? [])
    .map((para) =>
      [...para.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
        .map((m) => decodeEntities(m[1]))
        .join('')
        .trim(),
    )
    .filter(Boolean)
    .join('\n')
}

// Resolve a relationship Target (which may be relative, e.g. ../notesSlides/x)
// against the part that declared it.
function resolvePath(base: string, target: string): string {
  const parts = base.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

async function read(zip: JSZip, path: string): Promise<string | null> {
  const file = zip.file(path)
  return file ? file.async('string') : null
}

async function orderedSlidePaths(zip: JSZip): Promise<string[]> {
  const pres = await read(zip, 'ppt/presentation.xml')
  const relsXml = await read(zip, 'ppt/_rels/presentation.xml.rels')
  if (pres && relsXml) {
    const relMap = new Map(
      [...relsXml.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)].map(
        (m) => [m[1], m[2]] as const,
      ),
    )
    const ordered = [...pres.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)]
      .map((m) => relMap.get(m[1]))
      .filter((t): t is string => Boolean(t))
      .map((t) => resolvePath('ppt/presentation.xml', t))
    if (ordered.length) return ordered
  }
  // Fallback: every slide part, sorted numerically by filename.
  return Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0))
}

async function notesFor(zip: JSZip, slidePath: string): Promise<string> {
  const relsPath = slidePath.replace(/slides\/([^/]+)$/, 'slides/_rels/$1.rels')
  const relsXml = await read(zip, relsPath)
  if (!relsXml) return ''
  const m = relsXml.match(/Target="([^"]*notesSlide[^"]*)"/)
  if (!m) return ''
  const notesXml = await read(zip, resolvePath(slidePath, m[1]))
  return notesXml ? textFromXml(notesXml) : ''
}

export async function parsePptxToMarkdown(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)
  const slides = await orderedSlidePaths(zip)

  const sections: string[] = []
  for (let i = 0; i < slides.length; i++) {
    const xml = await read(zip, slides[i])
    const text = xml ? textFromXml(xml) : ''
    const notes = await notesFor(zip, slides[i])
    let section = `## Slide ${i + 1}`
    if (text) section += `\n\n${text}`
    if (notes) section += `\n\n**Notes:** ${notes}`
    sections.push(section)
  }
  return sections.join('\n\n').trim()
}
