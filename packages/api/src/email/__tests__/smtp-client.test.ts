import { describe, it, expect, vi } from 'vitest'
import { createTransport } from 'nodemailer'
import {
  createSmtpClient,
  resolveSmtpTransportOptions,
  senderMailbox,
  SMTP_CONNECTION_TIMEOUT_MS,
  SMTP_GREETING_TIMEOUT_MS,
  SMTP_SOCKET_TIMEOUT_MS,
  type SmtpTransport,
} from '../smtp-client.js'
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

describe('[COMP:api/smtp-client] transport configuration', () => {
  it('uses a configured SMTP server with implicit TLS', () => {
    expect(resolveSmtpTransportOptions({
      host: 'smtp.mail.example',
      port: '465',
      secure: true,
      user: 'mailer@example.com',
      password: 'secret',
    })).toEqual({
      host: 'smtp.mail.example',
      port: 465,
      secure: true,
      auth: { user: 'mailer@example.com', pass: 'secret' },
      connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
      socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    })
  })

  it('bounds a stalled server well below nodemailer\'s 10-minute socket default', () => {
    const opts = resolveSmtpTransportOptions({ user: 'mailer@example.com', password: 'secret' })
    expect(opts.connectionTimeout).toBeLessThanOrEqual(30_000)
    expect(opts.greetingTimeout).toBeLessThanOrEqual(30_000)
    expect(opts.socketTimeout).toBeLessThanOrEqual(120_000)
  })

  it('retains the Gmail STARTTLS defaults for existing deployments', () => {
    expect(resolveSmtpTransportOptions({
      user: 'mailer@example.com',
      password: 'secret',
    })).toMatchObject({ host: 'smtp.gmail.com', port: 587, secure: false })
  })

  it('rejects invalid SMTP ports', () => {
    expect(() => resolveSmtpTransportOptions({
      port: 'not-a-port',
      user: 'mailer@example.com',
      password: 'secret',
    })).toThrow(/SMTP_PORT/)
  })
})

describe('[COMP:api/smtp-client] sendMagicLink', () => {
  it('sends from the configured From: address', async () => {
    const { transport, calls } = makeFakeTransport()
    const client = createSmtpClient({ transport, fromAddress: 'auth@usebrian.ai' })

    await client.sendMagicLink('a@b.com', 'https://usebrian.ai/api/auth/email/verify?token=x')

    expect(calls).toHaveLength(1)
    expect(calls[0].from).toBe('auth@usebrian.ai')
    expect(calls[0].to).toBe('a@b.com')
  })

  it('defaults to English when no locale is given', async () => {
    const { transport, calls } = makeFakeTransport()
    const client = createSmtpClient({ transport, fromAddress: 'auth@usebrian.ai' })

    await client.sendMagicLink('a@b.com', 'https://usebrian.ai/x')

    expect(calls[0].subject).toBe(renderMagicLinkEmail('https://usebrian.ai/x', 'en').subject)
  })

  it('renders the localized subject and body when locale is set', async () => {
    const { transport, calls } = makeFakeTransport()
    const client = createSmtpClient({ transport, fromAddress: 'auth@usebrian.ai' })

    await client.sendMagicLink('a@b.com', 'https://usebrian.ai/x', 'ja')

    const ja = renderMagicLinkEmail('https://usebrian.ai/x', 'ja')
    expect(calls[0].subject).toBe(ja.subject)
    expect(calls[0].html).toBe(ja.html)
    expect(calls[0].text).toBe(ja.text)
  })

  it('embeds the verify link in both html and text bodies', async () => {
    const { transport, calls } = makeFakeTransport()
    const client = createSmtpClient({ transport, fromAddress: 'auth@usebrian.ai' })
    const link = 'https://usebrian.ai/api/auth/email/verify?token=abc123'

    await client.sendMagicLink('a@b.com', link)

    expect(calls[0].html).toContain(link)
    expect(calls[0].text).toContain(link)
  })

  it('threads the OTP code into the rendered email', async () => {
    const { transport, calls } = makeFakeTransport()
    const client = createSmtpClient({ transport, fromAddress: 'auth@usebrian.ai' })

    await client.sendMagicLink('a@b.com', 'https://usebrian.ai/login/verify?token=x', 'en', '482917')

    expect(calls[0].html).toContain('482917')
    expect(calls[0].text).toContain('482917')
  })

  it('propagates transport errors', async () => {
    const transport: SmtpTransport = {
      sendMail: vi.fn().mockRejectedValueOnce(new Error('SMTP 535: auth failed')),
    }
    const client = createSmtpClient({ transport, fromAddress: 'auth@usebrian.ai' })

    await expect(
      client.sendMagicLink('a@b.com', 'https://usebrian.ai/x'),
    ).rejects.toThrow('SMTP 535: auth failed')
  })
})

describe('[COMP:api/smtp-client] sendWorkspaceInvitation', () => {
  const inviteOpts = {
    link: 'https://usebrian.ai/invite?token=abc',
    workspaceName: 'AI Trading',
    inviterName: 'Hinson Wong',
    role: 'member' as const,
    message: null,
  }

  it('sends from "Use Brian - <workspace>" on the configured address', async () => {
    const { transport, calls } = makeFakeTransport()
    const client = createSmtpClient({ transport, fromAddress: 'contact@usebrian.ai' })

    await client.sendWorkspaceInvitation('a@b.com', inviteOpts)

    expect(calls).toHaveLength(1)
    expect(calls[0].from).toEqual({
      name: 'Use Brian - AI Trading',
      address: 'contact@usebrian.ai',
    })
    expect(calls[0].to).toBe('a@b.com')
  })

  it('sends from the bare mailbox when the configured From: carries a display name', async () => {
    const { transport, calls } = makeFakeTransport()
    const client = createSmtpClient({
      transport,
      fromAddress: '"Example Sender" <noreply@example.com>',
    })

    await client.sendWorkspaceInvitation('a@b.com', inviteOpts)

    expect(calls[0].from).toEqual({
      name: 'Use Brian - AI Trading',
      address: 'noreply@example.com',
    })
  })

  // The object `from` form is copied into the SMTP envelope verbatim, so the
  // assertion that matters is the MAIL FROM the real library would send, not
  // the object handed to it. Strict servers refuse anything but a mailbox
  // there (`500 5.5.4 Unknown MAIL FROM argument`).
  it.each([
    ['a bare address', 'noreply@example.com'],
    ['a quoted display name', '"Example Sender" <noreply@example.com>'],
    ['an unquoted display name', 'Example Sender <noreply@example.com>'],
  ])('puts only the mailbox in MAIL FROM when configured with %s', async (_label, fromAddress) => {
    const envelopes: Array<{ from?: string | false; to?: string[] }> = []
    const streaming = createTransport({ streamTransport: true, buffer: true })
    const transport: SmtpTransport = {
      async sendMail(o) {
        const info = await streaming.sendMail(o)
        envelopes.push(info.envelope as { from?: string | false; to?: string[] })
        return info
      },
    }
    const client = createSmtpClient({ transport, fromAddress })

    await client.sendWorkspaceInvitation('invitee@example.com', { ...inviteOpts, workspaceName: '工作區' })
    await client.sendMagicLink('invitee@example.com', 'https://app.example.com/x')

    expect(envelopes.map((e) => e.from)).toEqual(['noreply@example.com', 'noreply@example.com'])
  })

  it('renders the localized invitation subject and body', async () => {
    const { transport, calls } = makeFakeTransport()
    const client = createSmtpClient({ transport, fromAddress: 'contact@usebrian.ai' })

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
    const client = createSmtpClient({ transport, fromAddress: 'contact@usebrian.ai' })

    await expect(
      client.sendWorkspaceInvitation('a@b.com', inviteOpts),
    ).rejects.toThrow('SMTP 535: auth failed')
  })
})

describe('[COMP:api/smtp-client] senderMailbox', () => {
  it.each([
    ['noreply@example.com', 'noreply@example.com'],
    ['  noreply@example.com  ', 'noreply@example.com'],
    ['"Example Sender" <noreply@example.com>', 'noreply@example.com'],
    ['Example Sender <noreply@example.com>', 'noreply@example.com'],
    ['<noreply@example.com>', 'noreply@example.com'],
  ])('reduces %j to its mailbox', (input, expected) => {
    expect(senderMailbox(input)).toBe(expected)
  })

  it('returns an unparseable value unchanged so the transport reports it', () => {
    expect(senderMailbox('not an address')).toBe('not an address')
  })
})

describe('[COMP:api/smtp-client] renderMagicLinkEmail', () => {
  it('produces four distinct localized subjects', () => {
    const en = renderMagicLinkEmail('https://x', 'en')
    const ja = renderMagicLinkEmail('https://x', 'ja')
    const zh = renderMagicLinkEmail('https://x', 'zh')
    const zhCN = renderMagicLinkEmail('https://x', 'zh-CN')
    const subjects = [en.subject, ja.subject, zh.subject, zhCN.subject]
    expect(new Set(subjects).size).toBe(4)
  })

  it('renders zh-CN in Simplified script (登录, never 登入)', () => {
    const { subject, html, text } = renderMagicLinkEmail('https://x', 'zh-CN', '123456')
    expect(subject).toContain('登录')
    expect(html).toContain('登录')
    expect(html).not.toContain('登入')
    expect(text).not.toContain('登入')
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
