import { describe, it, expect } from 'vitest'
import { composeMailboxMessage, sanitizeHeaderValue } from '../smtp.js'

describe('[COMP:api/mailbox-imap-client] SMTP compose (markdown → multipart/alternative)', () => {
  it('renders markdown into a multipart/alternative message with text + html parts', async () => {
    const composed = await composeMailboxMessage({
      from: 'me@corp.com',
      to: ['ada@acme.com'],
      subject: 'Q3 numbers',
      body: 'Hi Ada,\n\n**Revenue is up.**\n\n- item one\n- item two',
    })
    const raw = composed.raw.toString('utf8')
    expect(raw).toContain('multipart/alternative')
    expect(raw).toContain('text/plain')
    expect(raw).toContain('text/html')
    expect(raw).toContain('<strong>Revenue is up.</strong>')
    expect(raw).not.toContain('**Revenue is up.**\r\n\r\n<')  // markdown not shipped as the html part
    expect(composed.messageId).toBeTruthy()
    expect(composed.envelope).toEqual({ from: 'me@corp.com', to: ['ada@acme.com'] })
  })

  it('sets In-Reply-To and References for a reply', async () => {
    const composed = await composeMailboxMessage({
      from: 'me@corp.com',
      to: ['ada@acme.com'],
      subject: 'Re: Q3 numbers',
      body: 'Agreed.',
      inReplyTo: '<root@acme.com>',
      references: ['<start@acme.com>', '<root@acme.com>'],
    })
    const raw = composed.raw.toString('utf8')
    expect(raw).toMatch(/In-Reply-To: <root@acme\.com>/)
    expect(raw).toMatch(/References: <start@acme\.com> <root@acme\.com>/)
  })

  it('strips CR/LF from to/subject — an injection attempt cannot add a header line', async () => {
    const composed = await composeMailboxMessage({
      from: 'me@corp.com',
      to: ['victim@acme.com\r\nBcc: attacker@evil.com'],
      subject: 'Hello\r\nX-Injected: 1',
      body: 'plain',
    })
    const raw = composed.raw.toString('utf8')
    expect(raw).not.toMatch(/^Bcc:/im)
    expect(raw).not.toMatch(/^X-Injected:/im)
    expect(composed.envelope.to).toEqual(['victim@acme.com Bcc: attacker@evil.com'])
  })

  it('sanitizeHeaderValue collapses newline runs to a single space', () => {
    expect(sanitizeHeaderValue('a\r\nb\nc')).toBe('a b c')
    expect(sanitizeHeaderValue('  clean  ')).toBe('clean')
  })

  it('writes a visible Cc header and lists cc recipients in the envelope', async () => {
    const composed = await composeMailboxMessage({
      from: 'me@corp.com',
      to: ['ada@acme.com'],
      cc: ['lead@corp.com', 'pm@corp.com'],
      subject: 'Kickoff',
      body: 'Looping in the team.',
    })
    const raw = composed.raw.toString('utf8')
    expect(raw).toMatch(/^Cc: .*lead@corp\.com/im)
    expect(raw).toContain('pm@corp.com')
    // Envelope RCPT list must include to + cc so the copied people receive it.
    expect(composed.envelope.to).toEqual(['ada@acme.com', 'lead@corp.com', 'pm@corp.com'])
  })

  it('delivers bcc via the envelope but never writes a Bcc header (Sent-copy leak guard)', async () => {
    const composed = await composeMailboxMessage({
      from: 'me@corp.com',
      to: ['ada@acme.com'],
      bcc: ['silent@corp.com'],
      subject: 'FYI',
      body: 'Quiet copy.',
    })
    const raw = composed.raw.toString('utf8')
    // The raw bytes are also APPENDed to the IMAP Sent folder — a Bcc header
    // here would leak the blind recipient to anyone reading the Sent copy.
    expect(raw).not.toMatch(/^Bcc:/im)
    expect(raw).not.toContain('silent@corp.com')
    // ...but the blind recipient must still be delivered to, via the envelope.
    expect(composed.envelope.to).toEqual(['ada@acme.com', 'silent@corp.com'])
  })
})
