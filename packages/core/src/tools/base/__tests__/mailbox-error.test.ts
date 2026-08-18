/**
 * [COMP:tools/mailbox-error] — the shared IMAP / SMTP failure classifier +
 * renderer consumed by the connect-time verifier (api `mailbox/verify.ts`)
 * and the runtime mailbox tools (`tools/base/mailbox.ts`).
 */

import { describe, it, expect } from 'vitest'
import { createMailboxTools, singleMailboxRouter, type MailboxApi } from '../mailbox.js'
import {
  classifyMailboxAuthFailure,
  classifyMailboxFailure,
  describeMailboxError,
  isMailboxAuthError,
  mailboxErrorText,
} from '../_mailbox-error.js'

const imapAuth = Object.assign(new Error('Invalid credentials (Failure)'), {
  authenticationFailed: true,
  responseText: '[AUTHENTICATIONFAILED] Invalid credentials (Failure)',
})
const smtpAuth = Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted.'), {
  code: 'EAUTH',
  response: '535-5.7.8 Username and Password not accepted.',
})
const disabled = Object.assign(new Error('LOGIN failed'), {
  authenticationFailed: true,
  responseText: '[ALERT] IMAP access is disabled for your account. Enable it in settings.',
})
const unreachable = Object.assign(new Error('getaddrinfo ENOTFOUND imap.example'), { code: 'ENOTFOUND' })

describe('[COMP:tools/mailbox-error] classification', () => {
  it('reads the server text (message + response/responseText) and the auth flags of both libraries', () => {
    expect(mailboxErrorText(imapAuth)).toBe('Invalid credentials (Failure) [AUTHENTICATIONFAILED] Invalid credentials (Failure)')
    expect(isMailboxAuthError(imapAuth)).toBe(true)
    expect(isMailboxAuthError(smtpAuth)).toBe(true)
    expect(isMailboxAuthError(unreachable)).toBe(false)
  })

  it('wrong password vs admin-gated access, unreachable host, and the rest', () => {
    expect(classifyMailboxAuthFailure(imapAuth)).toBe('auth_failed')
    expect(classifyMailboxAuthFailure(disabled)).toBe('access_disabled')
    expect(classifyMailboxFailure(imapAuth)).toBe('auth_failed')
    expect(classifyMailboxFailure(disabled)).toBe('access_disabled')
    expect(classifyMailboxFailure(unreachable)).toBe('unreachable')
    expect(classifyMailboxFailure(new Error('Command failed: NO [TRYCREATE] Mailbox doesn\'t exist: Archive/2020'))).toBe('not_found')
    expect(classifyMailboxFailure(new Error('Message rejected: 550 5.1.1 Recipient address rejected: User unknown'))).toBe('rejected')
    expect(classifyMailboxFailure(new Error('451 4.3.0 Temporary system problem. Try again later.'))).toBe('transient')
    expect(classifyMailboxFailure(new Error('something odd'))).toBe('unknown')
  })
})

describe('[COMP:tools/mailbox-error] describeMailboxError', () => {
  const ctx = { tool: 'imapSearchMessages', email: 'ops@example.com' }

  it('auth_failed → names the mailbox, keeps "invalid or expired" (health classifier), reconnect, no retry', () => {
    const text = describeMailboxError(imapAuth, ctx)
    expect(text).toContain('mailbox ops@example.com rejected the stored login while running `imapSearchMessages`')
    expect(text).toContain('invalid or expired')
    expect(text).toContain('Reconnect the mailbox with a fresh app password (Studio → Connectors)')
    expect(text).toContain('retrying will not help')
  })

  it('access_disabled → the account is gated, not the password; NO dead-credential marker', () => {
    const text = describeMailboxError(disabled, ctx)
    expect(text).toContain('because the account is gated, not because the password is wrong')
    expect(text).toContain('enable IMAP / SMTP or third-party access')
    expect(text).not.toMatch(/invalid or expired/)
  })

  it('unreachable → network problem, retry once', () => {
    const text = describeMailboxError(unreachable, ctx)
    expect(text).toContain('could not be reached')
    expect(text).toContain('(ENOTFOUND)')
    expect(text).toContain('Retry once')
  })

  it('send failures say the email was NOT sent (or that it is uncertain after a transient)', () => {
    const send = { tool: 'imapSendMessage', email: 'ops@example.com', target: 'the message to a@b.example', send: true }
    expect(describeMailboxError(smtpAuth, send)).toMatch(/^The email was NOT sent\. /)
    expect(describeMailboxError(new Error('550 5.1.1 Recipient address rejected: User unknown'), send)).toMatch(/^The email was NOT sent\. .*policy rejection/)
    expect(describeMailboxError(new Error('451 4.3.0 Temporary system problem'), send)).toMatch(/^The email may or may not have been sent/)
    expect(describeMailboxError(unreachable, send)).toContain('almost certainly NOT sent')
  })

  it('not_found names the target and the discovery tool; unknown passes the text through with a verdict', () => {
    const nf = describeMailboxError(new Error('NO [NONEXISTENT] Unknown Mailbox: Foo'), { tool: 'imapSearchMessages', email: 'ops@example.com', target: 'folder `Foo`' })
    expect(nf).toContain('has no folder `Foo`')
    expect(nf).toContain('imapSearchMessages')
    expect(nf).toContain('retrying this exact one will keep failing')
    const unknown = describeMailboxError('boom', ctx)
    expect(unknown).toContain('failed `imapSearchMessages`: boom')
  })
})

describe('[COMP:tools/mailbox-error] wired into the mailbox tools', () => {
  it('imapSendMessage renders an SMTP auth rejection as NOT sent + reconnect', async () => {
    const api: MailboxApi = {
      searchMessages: async () => ({ hits: [] }),
      getMessage: async () => { throw new Error('unused') },
      getAttachment: async () => { throw new Error('unused') },
      sendMessage: async () => { throw smtpAuth },
    }
    const tools = createMailboxTools(singleMailboxRouter(api, 'ops@example.com'))
    const send = tools.find((t) => t.name === 'imapSendMessage')!
    const res = await send.execute({ to: ['a@b.example'], subject: 'hi', body: 'x' }, { workspaceId: 'ws-1' } as never)
    expect(res.isError).toBe(true)
    expect(String(res.data)).toMatch(/^The email was NOT sent\. mailbox ops@example.com rejected the stored login/)
    expect(String(res.data)).toContain('the message to a@b.example')
  })
})
