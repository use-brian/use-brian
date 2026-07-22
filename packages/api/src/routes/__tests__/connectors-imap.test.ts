import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import { connectorRoutes } from '../connectors.js'
import { createTestApp } from './helpers.js'
import type { ConnectorInstanceStore } from '../../db/connector-instance-store.js'
import type { ConnectorStore } from '../../db/connector-store.js'
import type { MailboxPreset } from '../../mailbox/types.js'

const USER = 'user_1'

const ALIMAIL: MailboxPreset = {
  presetId: 'alimail',
  label: 'Alibaba enterprise mail',
  imapHost: 'imap.qiye.aliyun.com',
  imapPort: 993,
  smtpHost: 'smtp.qiye.aliyun.com',
  smtpPort: 465,
}

function makeApp(over: {
  verifyOk?: boolean
  verifyCode?: 'auth_failed' | 'access_disabled' | 'unreachable'
  preset?: MailboxPreset | null
  existing?: { id: string; provider: string } | null
} = {}) {
  const createUserInstance = vi.fn(async () => ({ id: 'inst_new' }))
  const update = vi.fn(async () => ({ id: 'inst_existing' }))
  const listByUser = vi.fn(async () => (over.existing ? [over.existing] : []))
  const verify = vi.fn(async () =>
    over.verifyOk === false
      ? { ok: false as const, code: over.verifyCode ?? 'auth_failed' as const, message: 'nope' }
      : { ok: true as const },
  )
  const resolvePreset = vi.fn(async () => (over.preset === undefined ? ALIMAIL : over.preset))
  const router = connectorRoutes({
    connectorStore: {} as ConnectorStore,
    connectorInstanceStore: {
      createUserInstance, update, listByUser,
    } as unknown as ConnectorInstanceStore,
    imapMailbox: { verify: verify as never, resolvePreset: resolvePreset as never },
  })
  const app = createTestApp('/api/connectors', router, { userId: USER })
  return { app, createUserInstance, update, listByUser, verify, resolvePreset }
}

describe('[COMP:api/mailbox-connect-routes] POST /imap/resolve', () => {
  it('returns the MX-resolved preset for the dialog', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/connectors/imap/resolve').send({ email: 'maya@harborlane.example' })
    expect(res.status).toBe(200)
    expect(res.body.preset.presetId).toBe('alimail')
  })

  it('returns null preset for an unrecognized domain (dialog expands Advanced)', async () => {
    const { app } = makeApp({ preset: null })
    const res = await request(app).post('/api/connectors/imap/resolve').send({ email: 'x@unknown.io' })
    expect(res.status).toBe(200)
    expect(res.body.preset).toBeNull()
  })

  it('rejects a non-email', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/connectors/imap/resolve').send({ email: 'nope' })
    expect(res.status).toBe(400)
  })
})

describe('[COMP:api/mailbox-connect-routes] POST /imap/connect', () => {
  it('verifies live (IMAP + SMTP) then stores a user-scoped instance with the typed imap credentials', async () => {
    const { app, createUserInstance, verify } = makeApp()
    const res = await request(app).post('/api/connectors/imap/connect').send({
      email: 'maya@harborlane.example', appPassword: 'client-security-pw',
    })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({
      email: 'maya@harborlane.example',
      imapHost: 'imap.qiye.aliyun.com', imapPort: 993,
      smtpHost: 'smtp.qiye.aliyun.com', smtpPort: 465,
    }))
    expect(createUserInstance).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER,
      provider: 'imap',
      label: 'maya@harborlane.example',
      connected: true,
      credentials: expect.objectContaining({ type: 'imap', appPassword: 'client-security-pw' }),
    }))
  })

  it('honors explicit Advanced hosts without resolving MX', async () => {
    const { app, verify, resolvePreset } = makeApp({ preset: null })
    const res = await request(app).post('/api/connectors/imap/connect').send({
      email: 'ops@selfhosted.io', appPassword: 'pw',
      imapHost: 'mail.selfhosted.io', imapPort: 993,
      smtpHost: 'mail.selfhosted.io', smtpPort: 465,
    })
    expect(res.status).toBe(200)
    expect(resolvePreset).not.toHaveBeenCalled()
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ imapHost: 'mail.selfhosted.io' }))
  })

  it('400s with hosts_required when MX is unrecognized and no hosts were given', async () => {
    const { app, createUserInstance } = makeApp({ preset: null })
    const res = await request(app).post('/api/connectors/imap/connect').send({
      email: 'x@unknown.io', appPassword: 'pw',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('hosts_required')
    expect(createUserInstance).not.toHaveBeenCalled()
  })

  it('a failed live verify stores NOTHING and names the failure', async () => {
    const { app, createUserInstance, update } = makeApp({ verifyOk: false, verifyCode: 'access_disabled' })
    const res = await request(app).post('/api/connectors/imap/connect').send({
      email: 'maya@harborlane.example', appPassword: 'login-password-not-app-password',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('verification_failed')
    expect(res.body.code).toBe('access_disabled')
    expect(createUserInstance).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('updates the existing instance instead of creating a second (D11 single-account)', async () => {
    const { app, createUserInstance, update } = makeApp({ existing: { id: 'inst_existing', provider: 'imap' } })
    const res = await request(app).post('/api/connectors/imap/connect').send({
      email: 'maya@harborlane.example', appPassword: 'pw',
    })
    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalledWith(USER, 'inst_existing', expect.objectContaining({ connected: true }))
    expect(createUserInstance).not.toHaveBeenCalled()
  })

  it('rejects missing password / invalid email', async () => {
    const { app } = makeApp()
    expect((await request(app).post('/api/connectors/imap/connect').send({ email: 'a@b.c' })).status).toBe(400)
    expect((await request(app).post('/api/connectors/imap/connect').send({ email: 'nope', appPassword: 'x' })).status).toBe(400)
  })
})
