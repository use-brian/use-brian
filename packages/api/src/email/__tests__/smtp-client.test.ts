import { describe, it, expect, vi } from 'vitest'
import { createSmtpClient, type SmtpTransport } from '../smtp-client.js'
import { renderMagicLinkEmail } from '../magic-link-template.js'
import { renderWorkspaceInviteEmail } from '../workspace-invite-template.js'

function makeFakeTransport() {
  const calls: Array<Parameters<SmtpTransport['sendMail']>[0]> = []
  const transport: SmtpTransport = {
    async sendMail(opts) {
      calls.push(opts)
    },
  }
  return { transport, calls }
}

describe('[COMP:api/smtp-client] sendMagicLink', () => {
  it('sends from the configured From: address', async () => {
    const { transport, calls } = makeFakeTransport()
    const client = createSmtpClient({ transport, fromAddress: 'auth@sidan.ai' })

    await client.sendMagicLink('a@b.com', 'https://sidan.ai/api/auth/email/verify?token=x')

    expect(calls).toHaveLength(1)
    expect(calls[0].from).toBe('auth@sidan.ai')
    expect(calls[0].to).toBe('a@b.com')
  })

  it('defaults to English when no locale is given', async () => {
    const { transport, calls } = makeFakeTransport()
    const client = createSmtpClient({ transport, fromAddress: 'auth@sidan.ai' })

    await client.sendMagicLink('a@b.com', 'https://sidan.ai/x')

    expect(calls[0].subject).toBe(renderMagicLinkEmail('https://sidan.ai/x', 'en').subject)
  })

  it('renders the localized subject and body when locale is set', async () => {
    const { transport, calls } = makeFakeTransport()
    const client = createSmtpClient({ transport, fromAddress: 'auth@sidan.ai' })

    await client.sendMagicLink('a@b.com', 'https://sidan.ai/x', 'ja')

    const ja = renderMagicLinkEmail('https://sidan.ai/x', 'ja')
    expect(calls[0].subject).toBe(ja.subject)
    expect(calls[0].html).toBe(ja.html)
    expect(calls[0].text).toBe(ja.text)
  })

  it('embeds the verify link in both html and text bodies', async () => {
    const { transport, calls } = makeFakeTransport()
    const client = createSmtpClient({ transport, fromAddress: 'auth@sidan.ai' })
    const link = 'https://sidan.ai/api/auth/email/verify?token=abc123'

    await client.sendMagicLink('a@b.com', link)

    expect(calls[0].html).toContain(link)
    expect(calls[0].text).toContain(link)
  })

  it('threads the OTP code into the rendered email', async () => {
    const { transport, calls } = makeFakeTransport()
    const client = createSmtpClient({ transport, fromAddress: 'auth@sidan.ai' })

    await client.sendMagicLink('a@b.com', 'https://sidan.ai/login/verify?token=x', 'en', '482917')

    expect(calls[0].html).toContain('482917')
    expect(calls[0].text).toContain('482917')
  })

  it('propagates transport errors', async () => {
    const transport: SmtpTransport = {
      sendMail: vi.fn().mockRejectedValueOnce(new Error('SMTP 535: auth failed')),
    }
    const client = createSmtpClient({ transport, fromAddress: 'auth@sidan.ai' })

    await expect(
      client.sendMagicLink('a@b.com', 'https://sidan.ai/x'),
    ).rejects.toThrow('SMTP 535: auth failed')
  })
})

describe('[COMP:api/smtp-client] sendWorkspaceInvitation', () => {
  const inviteOpts = {
    link: 'https://sidan.ai/invite?token=abc',
    workspaceName: 'AI Trading',
    inviterName: 'Hinson Wong',
    role: 'member' as const,
    message: null,
  }

  it('sends from "sidanclaw - <workspace>" on the configured address', async () => {
    const { transport, calls } = makeFakeTransport()
    const client = createSmtpClient({ transport, fromAddress: 'contact@sidan.ai' })

    await client.sendWorkspaceInvitation('a@b.com', inviteOpts)

    expect(calls).toHaveLength(1)
    expect(calls[0].from).toEqual({
      name: 'sidanclaw - AI Trading',
      address: 'contact@sidan.ai',
    })
    expect(calls[0].to).toBe('a@b.com')
  })

  it('renders the localized invitation subject and body', async () => {
    const { transport, calls } = makeFakeTransport()
    const client = createSmtpClient({ transport, fromAddress: 'contact@sidan.ai' })

    await client.sendWorkspaceInvitation('a@b.com', { ...inviteOpts, locale: 'ja' })

    const ja = renderWorkspaceInviteEmail({ ...inviteOpts, locale: 'ja' })
    expect(calls[0].subject).toBe(ja.subject)
    expect(calls[0].html).toBe(ja.html)
    expect(calls[0].text).toBe(ja.text)
  })

  it('propagates transport errors so callers can log the failure', async () => {
    const transport: SmtpTransport = {
      sendMail: vi.fn().mockRejectedValueOnce(new Error('SMTP 535: auth failed')),
    }
    const client = createSmtpClient({ transport, fromAddress: 'contact@sidan.ai' })

    await expect(
      client.sendWorkspaceInvitation('a@b.com', inviteOpts),
    ).rejects.toThrow('SMTP 535: auth failed')
  })
})

describe('[COMP:api/smtp-client] renderMagicLinkEmail', () => {
  it('produces three distinct localized subjects', () => {
    const en = renderMagicLinkEmail('https://x', 'en')
    const ja = renderMagicLinkEmail('https://x', 'ja')
    const zh = renderMagicLinkEmail('https://x', 'zh')
    expect(en.subject).not.toBe(ja.subject)
    expect(ja.subject).not.toBe(zh.subject)
    expect(en.subject).not.toBe(zh.subject)
  })

  it('HTML-escapes the link to prevent injection', () => {
    const malicious = 'https://x" onclick="alert(1)'
    const { html } = renderMagicLinkEmail(malicious, 'en')
    expect(html).not.toContain('onclick="alert(1)')
    expect(html).toContain('https://x&quot;')
  })

  it('plain-text body contains the raw link (no escaping)', () => {
    const { text } = renderMagicLinkEmail('https://x?a=b&c=d', 'en')
    expect(text).toContain('https://x?a=b&c=d')
  })

  it('renders the 6-digit passcode block in html and text when a code is given', () => {
    const { html, text } = renderMagicLinkEmail('https://x', 'en', '482917')
    expect(html).toContain('482917')
    expect(text).toContain('482917')
  })

  it('omits the passcode block when no code is given (backward compatible)', () => {
    const { html } = renderMagicLinkEmail('https://x', 'en')
    // The label only appears when a code is rendered.
    expect(html).not.toContain('Or enter this code')
  })

  it('ignores a non-numeric code (only digit codes are ever rendered)', () => {
    const { html } = renderMagicLinkEmail('https://x', 'en', 'abc<script>')
    expect(html).not.toContain('abc')
    expect(html).not.toContain('<script>')
  })
})
