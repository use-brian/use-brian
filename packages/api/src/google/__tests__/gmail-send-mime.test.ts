/**
 * Unit tests for `sendGmailMessage` MIME assembly.
 * Component tag: [COMP:tools/gmail-attachments].
 *
 * Mocks global `fetch`. Verifies the two send paths: text-only stays on the
 * base64url-in-JSON endpoint byte-identical to before; attachments switch to
 * the media-upload endpoint with a decodable multipart/mixed RFC 822 body
 * (RFC 2047 subject, RFC 2231 filename*, base64 parts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendGmailMessage } from '../client.js'

const mockFetch = vi.fn()

function ok(data: unknown) {
  return { ok: true, status: 200, json: async () => data, text: async () => '' }
}

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockResolvedValue(ok({ id: 'msg-1', threadId: 'thr-1' }))
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const TOKEN = 'tok'
const BASE = { to: 'a@b.co', subject: 'Report', body: 'See attached.' }

function sentRequest(): { url: string; init: { headers: Record<string, string>; body: unknown } } {
  const [url, init] = mockFetch.mock.calls[0]
  return { url, init }
}

describe('[COMP:tools/gmail-attachments] sendGmailMessage MIME assembly', () => {
  it('text-only: posts base64url JSON to the plain send endpoint (legacy path unchanged)', async () => {
    const result = await sendGmailMessage(TOKEN, BASE)

    expect(result).toEqual({ id: 'msg-1', threadId: 'thr-1' })
    const { url, init } = sentRequest()
    expect(url).toBe('https://www.googleapis.com/gmail/v1/users/me/messages/send')
    expect(init.headers['Content-Type']).toBe('application/json')
    const raw = (JSON.parse(init.body as string) as { raw: string }).raw
    const decoded = Buffer.from(raw, 'base64url').toString('utf-8')
    expect(decoded).toContain('To: a@b.co')
    expect(decoded).toContain('Subject: Report')
    expect(decoded).toContain('See attached.')
  })

  it('with attachments: posts multipart/mixed RFC 822 to the upload endpoint', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 fake content')
    await sendGmailMessage(TOKEN, {
      ...BASE,
      attachments: [{ filename: 'receipt.pdf', mime: 'application/pdf', data: new Uint8Array(pdfBytes) }],
    })

    const { url, init } = sentRequest()
    expect(url).toBe('https://www.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media')
    expect(init.headers['Content-Type']).toBe('message/rfc822')
    expect(init.headers.Authorization).toBe('Bearer tok')

    const mime = (init.body as Buffer).toString('utf-8')
    expect(mime).toContain('To: a@b.co')
    expect(mime).toContain('Subject: Report')
    expect(mime).toContain('MIME-Version: 1.0')

    const boundary = /boundary="([^"]+)"/.exec(mime)?.[1]
    expect(boundary).toBeTruthy()
    const parts = mime.split(`--${boundary}`)
    // preamble/headers, text part, attachment part, closing '--'
    expect(parts).toHaveLength(4)
    expect(parts[3].trim()).toBe('--')

    expect(parts[1]).toContain('Content-Type: text/plain; charset=utf-8')
    expect(parts[1]).toContain('Content-Transfer-Encoding: base64')
    const textB64 = parts[1].split('\r\n\r\n')[1].replace(/\r\n/g, '').trim()
    expect(Buffer.from(textB64, 'base64').toString('utf-8')).toBe('See attached.')

    expect(parts[2]).toContain('Content-Type: application/pdf; name="receipt.pdf"')
    expect(parts[2]).toContain('Content-Disposition: attachment; filename="receipt.pdf"')
    expect(parts[2]).toContain('Content-Transfer-Encoding: base64')
    const attB64 = parts[2].split('\r\n\r\n')[1].replace(/\r\n/g, '').trim()
    expect(Buffer.from(attB64, 'base64').equals(pdfBytes)).toBe(true)
  })

  it('encodes non-ASCII subject (RFC 2047) and filename (RFC 2231 filename*)', async () => {
    await sendGmailMessage(TOKEN, {
      to: 'a@b.co',
      subject: '收據',
      body: 'x',
      attachments: [{ filename: '收據.pdf', mime: 'application/pdf', data: new Uint8Array([1]) }],
    })

    const mime = (sentRequest().init.body as Buffer).toString('utf-8')
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from('收據', 'utf-8').toString('base64')}?=`)
    expect(mime).toContain(`filename*=UTF-8''${encodeURIComponent('收據.pdf')}`)
    // ASCII fallback still present for old MUAs
    expect(mime).toContain('filename="__.pdf"')
  })

  it('folds attachment base64 to 76-char lines (RFC 2045)', async () => {
    await sendGmailMessage(TOKEN, {
      ...BASE,
      attachments: [{ filename: 'big.bin', mime: 'application/octet-stream', data: new Uint8Array(300) }],
    })

    const mime = (sentRequest().init.body as Buffer).toString('utf-8')
    const b64Block = mime.split('Content-Transfer-Encoding: base64\r\n\r\n')[2] ?? ''
    const lines = b64Block.split('\r\n').filter((l) => /^[A-Za-z0-9+/=]+$/.test(l))
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(76)
  })

  it('surfaces Gmail API errors from the upload endpoint', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 413, json: async () => ({}), text: async () => 'too large' })

    await expect(
      sendGmailMessage(TOKEN, {
        ...BASE,
        attachments: [{ filename: 'a.txt', mime: 'text/plain', data: new Uint8Array([1]) }],
      }),
    ).rejects.toThrow('Gmail API error (413): too large')
  })
})

describe('[COMP:tools/gmail-send-as] sendGmailMessage From header (alias sending)', () => {
  it('omits the From header when no alias is given (byte-identical to before)', async () => {
    await sendGmailMessage(TOKEN, BASE)

    const raw = (JSON.parse(sentRequest().init.body as string) as { raw: string }).raw
    const decoded = Buffer.from(raw, 'base64url').toString('utf-8')
    expect(decoded).not.toContain('From:')
  })

  it('sets the From header on the text-only path when an alias is given', async () => {
    await sendGmailMessage(TOKEN, { ...BASE, from: 'hinson.wong@usebrian.ai' })

    const raw = (JSON.parse(sentRequest().init.body as string) as { raw: string }).raw
    const decoded = Buffer.from(raw, 'base64url').toString('utf-8')
    expect(decoded).toContain('From: hinson.wong@usebrian.ai')
  })

  it('sets the From header on the multipart (attachments) path', async () => {
    await sendGmailMessage(TOKEN, {
      ...BASE,
      from: 'hinson.wong@usebrian.ai',
      attachments: [{ filename: 'a.txt', mime: 'text/plain', data: new Uint8Array([1]) }],
    })

    const mime = (sentRequest().init.body as Buffer).toString('utf-8')
    expect(mime).toContain('From: hinson.wong@usebrian.ai')
  })

  it('strips embedded CR/LF from To/From/Subject so no extra header line can be injected', async () => {
    await sendGmailMessage(TOKEN, {
      to: 'a@b.co\r\nBcc: evil@attacker.com',
      from: 'hinson.wong@usebrian.ai\r\nX-Injected: yes',
      subject: 'Hi\r\nBcc: evil@attacker.com',
      body: 'x',
    })

    const raw = (JSON.parse(sentRequest().init.body as string) as { raw: string }).raw
    const decoded = Buffer.from(raw, 'base64url').toString('utf-8')
    const lines = decoded.split('\r\n')
    // The injected text survives as inert trailing content on the To/From/Subject
    // lines themselves, but must never land on its OWN header line.
    expect(lines).not.toContain('Bcc: evil@attacker.com')
    expect(lines).not.toContain('X-Injected: yes')
    expect(lines.filter((l) => l.startsWith('Bcc:'))).toHaveLength(0)
    expect(lines.filter((l) => l.startsWith('X-Injected:'))).toHaveLength(0)
  })
})
