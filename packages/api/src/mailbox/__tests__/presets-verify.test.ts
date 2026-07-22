import { describe, it, expect } from 'vitest'
import { presetForMxHost, resolveMailboxPreset } from '../presets.js'
import { verifyMailboxConnection } from '../verify.js'
import type { MailboxAccountSettings } from '../types.js'

const SETTINGS: MailboxAccountSettings = {
  email: 'maya@harborlane.example',
  appPassword: 'app-pass',
  imapHost: 'imap.qiye.aliyun.com',
  imapPort: 993,
  smtpHost: 'smtp.qiye.aliyun.com',
  smtpPort: 465,
}

describe('[COMP:api/mailbox-connect-routes] MX preset resolution', () => {
  it('maps qiye.aliyun.com MX hosts (and the mxhichina legacy alias) to the AliMail preset', () => {
    expect(presetForMxHost('mx1.qiye.aliyun.com')?.presetId).toBe('alimail')
    expect(presetForMxHost('MX2.QIYE.ALIYUN.COM.')?.presetId).toBe('alimail')
    expect(presetForMxHost('mx3.mxhichina.com')?.presetId).toBe('alimail')
    expect(presetForMxHost('aspmx.l.google.com')).toBeNull()
    expect(presetForMxHost('evil-qiye.aliyun.com.attacker.io')).toBeNull()
  })

  it('resolves via MX lookup, lowest priority first', async () => {
    const preset = await resolveMailboxPreset('maya@harborlane.example', async () => [
      { exchange: 'backup.other-host.com', priority: 10 },
      { exchange: 'mx1.qiye.aliyun.com', priority: 5 },
    ])
    expect(preset?.presetId).toBe('alimail')
    expect(preset?.imapHost).toBe('imap.qiye.aliyun.com')
    expect(preset?.smtpPort).toBe(465)
  })

  it('returns null for unrecognized MX, unresolvable domains, and bare strings', async () => {
    expect(await resolveMailboxPreset('x@gmail.com', async () => [{ exchange: 'aspmx.l.google.com', priority: 1 }])).toBeNull()
    expect(await resolveMailboxPreset('x@dead.invalid', async () => { throw new Error('ENOTFOUND') })).toBeNull()
    expect(await resolveMailboxPreset('not-an-email', async () => [])).toBeNull()
  })
})

describe('[COMP:api/mailbox-connect-routes] Connect-time verification (named errors)', () => {
  it('passes when both IMAP and SMTP verify', async () => {
    const result = await verifyMailboxConnection(SETTINGS, {
      verifyImap: async () => {},
      verifySmtp: async () => {},
    })
    expect(result).toEqual({ ok: true })
  })

  it('classifies an IMAP auth rejection as wrong-password', async () => {
    const err = Object.assign(new Error('Invalid credentials'), { authenticationFailed: true })
    const result = await verifyMailboxConnection(SETTINGS, {
      verifyImap: async () => { throw err },
      verifySmtp: async () => {},
    })
    expect(result).toMatchObject({ ok: false, code: 'auth_failed' })
  })

  it('classifies a disabled-service response as access_disabled (admin must enable third-party access)', async () => {
    const err = Object.assign(new Error('LOGIN failed'), {
      authenticationFailed: true,
      responseText: 'IMAP service is disabled for this account',
    })
    const result = await verifyMailboxConnection(SETTINGS, {
      verifyImap: async () => { throw err },
      verifySmtp: async () => {},
    })
    expect(result).toMatchObject({ ok: false, code: 'access_disabled' })
  })

  it('classifies network failures as unreachable', async () => {
    const err = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })
    const result = await verifyMailboxConnection(SETTINGS, {
      verifyImap: async () => { throw err },
      verifySmtp: async () => {},
    })
    expect(result).toMatchObject({ ok: false, code: 'unreachable' })
  })

  it('names the SMTP leg when IMAP verified but SMTP fails', async () => {
    const auth = Object.assign(new Error('535 auth failed'), { code: 'EAUTH' })
    expect(
      await verifyMailboxConnection(SETTINGS, {
        verifyImap: async () => {},
        verifySmtp: async () => { throw auth },
      }),
    ).toMatchObject({ ok: false, code: 'auth_failed' })

    const proto = new Error('unexpected greeting')
    expect(
      await verifyMailboxConnection(SETTINGS, {
        verifyImap: async () => {},
        verifySmtp: async () => { throw proto },
      }),
    ).toMatchObject({ ok: false, code: 'smtp_failed' })
  })
})
