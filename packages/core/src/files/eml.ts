/**
 * Email message (.eml / message/rfc822) → Markdown. [COMP:files/eml]
 *
 * Forwarding a saved message into the brain is one of the most ordinary things
 * a user tries, and the upload gate refused it outright.
 *
 * **Why `mailparser` rather than an in-stack walk.** The `.pptx` / OpenDocument
 * parsers deliberately avoid a library, because a zip of XML is a shape a regex
 * scan handles honestly. MIME is not that shape: header folding, RFC 2047
 * encoded-words, nested multipart boundaries, quoted-printable and base64
 * transfer encodings, and — the one that decides it — legacy charsets. A large
 * share of this product's mail is CJK, where a hand-rolled parser silently
 * produces mojibake instead of failing. `mailparser` is already the workspace's
 * answer to exactly this problem: the IMAP connector
 * (`packages/api/src/mailbox/`) has parsed untrusted inbound mail with it in
 * production, so this adds an edge to the dependency graph, not a new trust
 * surface.
 *
 * The HTML alternative rides `htmlToMarkdown` (`./html.ts`), so an email body
 * gets the same whole-body conversion an uploaded `.html` file does.
 */
import { htmlToMarkdown } from './html.js'

export type EmlParseResult = {
  text: string
  subject?: string
  /** Attachment filenames, in order. The bytes are NOT extracted (see below). */
  attachments: string[]
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Parse an RFC 822 message to Markdown: an envelope block (subject, from, to,
 * cc, date, attachment manifest) followed by the body.
 *
 * Throws when the buffer is not a parseable message — the caller placeholders,
 * as for every other structured format.
 */
export async function parseEmlToMarkdown(buffer: Buffer): Promise<EmlParseResult> {
  const { simpleParser } = await import('mailparser')
  const parsed = await simpleParser(buffer)

  const subject = (parsed.subject ?? '').trim()
  const lines: string[] = []
  if (subject) lines.push(`# ${subject}`, '')

  const envelope: string[] = []
  const addr = (label: string, value: unknown) => {
    const text = (value as { text?: string } | undefined)?.text?.trim()
    if (text) envelope.push(`**${label}:** ${text}`)
  }
  addr('From', parsed.from)
  addr('To', parsed.to)
  addr('Cc', parsed.cc)
  if (parsed.date) envelope.push(`**Date:** ${parsed.date.toISOString()}`)

  // Attachments are named but never extracted here: this path derives the text
  // of ONE file, and an attachment is a different file with its own type,
  // parser, and size. Listing them keeps the model from either ignoring them or
  // claiming to have read them.
  const attachments = (parsed.attachments ?? [])
    .filter((a) => a.contentDisposition !== 'inline' || a.filename)
    .map((a) => ({
      name: (a.filename ?? 'unnamed').trim(),
      type: a.contentType ?? 'application/octet-stream',
      size: a.size ?? 0,
    }))
  if (attachments.length) {
    envelope.push(
      `**Attachments (not extracted):** ${attachments
        .map((a) => `${a.name} (${a.type}, ${formatBytes(a.size)})`)
        .join(', ')}`,
    )
  }

  if (envelope.length) lines.push(...envelope, '', '---', '')

  // Prefer the HTML alternative, converted by the same routine an uploaded
  // `.html` file gets, and fall back to the plain part.
  //
  // This deliberately inverts the IMAP connector's precedence
  // (`parsed.text ?? htmlToText(parsed.html)`), because the two paths want
  // different things. The connector renders a message for a chat turn, where
  // flat prose is fine. This path chunks a message into `file_segments` and
  // runs extraction over it, where headings, lists and tables are what make a
  // segment retrievable and a claim attributable. mailparser synthesises
  // `text` from the HTML when a message ships no plain part, and that
  // synthesis is exactly the structure loss worth avoiding here.
  let body = ''
  if (typeof parsed.html === 'string' && parsed.html) {
    body = (await htmlToMarkdown(parsed.html)).markdown
  }
  if (!body) body = (parsed.text ?? '').trim()
  if (body) lines.push(body)

  const text = lines.join('\n').trim()
  return {
    // An envelope with no body is not a document — say nothing rather than
    // indexing a header block as though it were content.
    text: body ? text : '',
    subject: subject || undefined,
    attachments: attachments.map((a) => a.name),
  }
}
