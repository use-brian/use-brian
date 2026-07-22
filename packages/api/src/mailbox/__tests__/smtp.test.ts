import { describe, it, expect } from 'vitest'
import { composeMailboxMessage, sanitizeHeaderValue } from '../smtp.js'

describe('[COMP:api/mailbox-imap-client] SMTP compose (markdown → multipart/alternative)', () => {
  it('renders markdown into a multipart/alternative message with text + html parts', async () => {
    const composed = await composeMailboxMessage({
      from: 'me@corp.com',
      to: 'ada@acme.com',
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
      to: 'ada@acme.com',
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
      to: 'victim@acme.com\r\nBcc: attacker@evil.com',
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
})
