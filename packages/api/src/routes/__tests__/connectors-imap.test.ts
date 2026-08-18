import { describe, it, expect, vi, afterEach } from 'vitest'
import request from 'supertest'
import { connectorRoutes } from '../connectors.js'
import { setGlobalMailboxSyncDeps } from '../../mailbox/sync-tool.js'
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
  existing?: { id: string; provider: string; scope?: string; connectedEmail?: string } | null
  /** Full listForUser rows (workspace-owned scenarios); wins over `existing`. */
  instances?: Array<Record<string, unknown>>
  /** Caller's membership in the instance's workspace (clearance gate). */
  membership?: { role: 'owner' | 'admin' | 'member'; clearance: 'public' | 'internal' | 'confidential' } | null
  /** Decrypted credentials for the resolved instance (sync-status path). */
  creds?: Record<string, unknown> | null
} = {}) {
  const createUserInstance = vi.fn(async () => ({ id: 'inst_new' }))
  const update = vi.fn(async () => ({ id: 'inst_existing' }))
  const listForUser = vi.fn(async () =>
    over.instances ?? (over.existing ? [over.existing] : []))
  const getAuthCredentialsSystem = vi.fn(async () => over.creds ?? null)
  const setConfigSystem = vi.fn(async () => {})
  const getMembershipWithClearance = vi.fn(async () => over.membership ?? null)
  const verify = vi.fn(async () =>
    over.verifyOk === false
      ? { ok: false as const, code: over.verifyCode ?? 'auth_failed' as const, message: 'nope' }
      : { ok: true as const },
  )
  const resolvePreset = vi.fn(async () => (over.preset === undefined ? ALIMAIL : over.preset))
  const countArchive = vi.fn(async () => ({ total: 3, byFolder: { INBOX: 3 } }))
  const router = connectorRoutes({
    connectorStore: {} as ConnectorStore,
    connectorInstanceStore: {
      createUserInstance, update, listForUser, getAuthCredentialsSystem, setConfigSystem,
    } as unknown as ConnectorInstanceStore,
    imapMailbox: {
      verify: verify as never,
      resolvePreset: resolvePreset as never,
      countArchive: countArchive as never,
      getMembershipWithClearance: getMembershipWithClearance as never,
    },
  })
  const app = createTestApp('/api/connectors', router, { userId: USER })
  return { app, createUserInstance, update, listForUser, verify, resolvePreset, getMembershipWithClearance, setConfigSystem }
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

  it('reconnecting the SAME address updates that instance in place (rotated app password)', async () => {
    const { app, createUserInstance, update } = makeApp({
      existing: { id: 'inst_existing', provider: 'imap', scope: 'user', connectedEmail: 'maya@harborlane.example' },
    })
    const res = await request(app).post('/api/connectors/imap/connect').send({
      email: 'maya@harborlane.example', appPassword: 'rotated-pw',
    })
    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalledWith(USER, 'inst_existing', expect.objectContaining({ connected: true }))
    expect(createUserInstance).not.toHaveBeenCalled()
  })

  it('connecting a DIFFERENT address adds another mailbox (multi-account, D11 retired)', async () => {
    const { app, createUserInstance, update } = makeApp({
      existing: { id: 'inst_existing', provider: 'imap', scope: 'user', connectedEmail: 'ops@other.example' },
    })
    const res = await request(app).post('/api/connectors/imap/connect').send({
      email: 'maya@harborlane.example', appPassword: 'pw',
    })
    expect(res.status).toBe(200)
    expect(createUserInstance).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'imap', connectedEmail: 'maya@harborlane.example', connected: true,
    }))
    expect(update).not.toHaveBeenCalled()
  })

  it('rejects missing password / invalid email', async () => {
    const { app } = makeApp()
    expect((await request(app).post('/api/connectors/imap/connect').send({ email: 'a@b.c' })).status).toBe(400)
    expect((await request(app).post('/api/connectors/imap/connect').send({ email: 'nope', appPassword: 'x' })).status).toBe(400)
  })
})

describe('[COMP:api/mailbox-connect-routes] transferred (workspace-owned) mailbox', () => {
  const WS_MAILBOX = {
    id: 'inst_ws',
    provider: 'imap',
    scope: 'workspace',
    workspaceId: 'ws_1',
    sensitivity: 'internal',
    connected: true,
    connectedEmail: 'maya@harborlane.example',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    config: {},
    ingestionEnabled: false,
  }
  const IMAP_CREDS = {
    type: 'imap',
    email: 'maya@harborlane.example',
    appPassword: 'pw',
    imapHost: 'imap.qiye.aliyun.com',
    imapPort: 993,
    smtpHost: 'smtp.qiye.aliyun.com',
    smtpPort: 465,
  }

  it('sync-status resolves a workspace-owned mailbox for a cleared member', async () => {
    const { app } = makeApp({
      instances: [WS_MAILBOX],
      membership: { role: 'member', clearance: 'internal' },
      creds: IMAP_CREDS,
    })
    const res = await request(app).get('/api/connectors/imap/sync-status')
    expect(res.status).toBe(200)
    expect(res.body.instanceId).toBe('inst_ws')
    expect(res.body.email).toBe('maya@harborlane.example')
  })

  it('sync-status 404s for an under-cleared member (clearance below sensitivity)', async () => {
    const { app } = makeApp({
      instances: [{ ...WS_MAILBOX, sensitivity: 'confidential' }],
      membership: { role: 'member', clearance: 'internal' },
      creds: IMAP_CREDS,
    })
    const res = await request(app).get('/api/connectors/imap/sync-status')
    expect(res.status).toBe(404)
  })

  it('connecting the SAME address rotates the workspace mailbox in place for a cleared member', async () => {
    const { app, createUserInstance, update } = makeApp({
      instances: [WS_MAILBOX],
      membership: { role: 'member', clearance: 'internal' },
    })
    const res = await request(app).post('/api/connectors/imap/connect').send({
      email: 'maya@harborlane.example', appPassword: 'rotated-pw',
    })
    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalledWith(USER, 'inst_ws', expect.objectContaining({ connected: true }))
    expect(createUserInstance).not.toHaveBeenCalled()
  })

  it('an under-cleared member connecting the same address gets their own personal instance instead', async () => {
    const { app, createUserInstance, update } = makeApp({
      instances: [{ ...WS_MAILBOX, sensitivity: 'confidential' }],
      membership: { role: 'member', clearance: 'internal' },
    })
    const res = await request(app).post('/api/connectors/imap/connect').send({
      email: 'maya@harborlane.example', appPassword: 'pw',
    })
    expect(res.status).toBe(200)
    expect(createUserInstance).toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/mailbox-connect-routes] send-as aliases (PATCH /imap/send-as + sync-status read-back)', () => {
  const MAILBOX = {
    id: 'inst_1',
    provider: 'imap',
    scope: 'user',
    connected: true,
    connectedEmail: 'contact@usebrian.example',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    config: { sendAsAliases: ['bd@usebrian.example'] },
    ingestionEnabled: true,
  }
  const CREDS = {
    type: 'imap', email: 'contact@usebrian.example', appPassword: 'pw',
    imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465,
  }

  it('writes a normalized, deduped, account-free list to config.sendAsAliases and echoes it', async () => {
    const { app, setConfigSystem } = makeApp({ instances: [MAILBOX], creds: CREDS })
    const res = await request(app)
      .patch('/api/connectors/imap/send-as')
      .send({ sendAsAliases: ['BD <BD@usebrian.example>', 'ops@usebrian.example', 'contact@usebrian.example', 'bd@usebrian.example'] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, instanceId: 'inst_1', sendAsAliases: ['bd@usebrian.example', 'ops@usebrian.example'] })
    expect(setConfigSystem).toHaveBeenCalledWith('inst_1', { sendAsAliases: ['bd@usebrian.example', 'ops@usebrian.example'] })
  })

  it('rejects the whole write when an entry is not an address (nothing stored)', async () => {
    const { app, setConfigSystem } = makeApp({ instances: [MAILBOX], creds: CREDS })
    const res = await request(app)
      .patch('/api/connectors/imap/send-as')
      .send({ sendAsAliases: ['bd@usebrian.example', 'not an address'] })
    expect(res.status).toBe(400)
    expect(res.body.invalid).toEqual(['not an address'])
    expect(setConfigSystem).not.toHaveBeenCalled()
    const shape = await request(app).patch('/api/connectors/imap/send-as').send({ sendAsAliases: 'bd@usebrian.example' })
    expect(shape.status).toBe(400)
  })

  it('404s without a connected mailbox; targets a specific instance with instanceId', async () => {
    const { app } = makeApp()
    expect((await request(app).patch('/api/connectors/imap/send-as').send({ sendAsAliases: [] })).status).toBe(404)
    const second = { ...MAILBOX, id: '11111111-1111-4111-8111-111111111111', connectedEmail: 'other@usebrian.example', createdAt: new Date('2026-02-01T00:00:00Z') }
    const { app: two, setConfigSystem } = makeApp({ instances: [MAILBOX, second], creds: CREDS })
    const res = await request(two)
      .patch('/api/connectors/imap/send-as')
      .send({ instanceId: second.id, sendAsAliases: ['sales@usebrian.example'] })
    expect(res.status).toBe(200)
    expect(setConfigSystem).toHaveBeenCalledWith(second.id, { sendAsAliases: ['sales@usebrian.example'] })
  })

  it('sync-status reads the configured aliases + the IDLE posture back for the panel', async () => {
    const idle = { status: 'connected', since: '2026-08-19T09:00:00.000Z', lastEventAt: '2026-08-19T09:41:00.000Z', lastError: null }
    const { app } = makeApp({ instances: [{ ...MAILBOX, config: { ...MAILBOX.config, mailboxIdle: idle } }], creds: CREDS })
    const res = await request(app).get('/api/connectors/imap/sync-status')
    expect(res.status).toBe(200)
    expect(res.body.sendAsAliases).toEqual(['bd@usebrian.example'])
    expect(res.body.idle).toEqual(idle)
    // Never watched → null, not a fabricated "off".
    const { app: bare } = makeApp({ instances: [MAILBOX], creds: CREDS })
    expect((await request(bare).get('/api/connectors/imap/sync-status')).body.idle).toBeNull()
  })
})

describe('[COMP:api/mailbox-connect-routes] sync-on-connect', () => {
  afterEach(() => setGlobalMailboxSyncDeps(null))

  it('fire-and-forgets a first sync of the newly created instance', async () => {
    const syncInstanceById = vi.fn(async () => ({ synced: true as const, newMessages: 0 }))
    setGlobalMailboxSyncDeps({ syncInstanceById })
    const { app } = makeApp()
    const res = await request(app).post('/api/connectors/imap/connect').send({
      email: 'maya@harborlane.example', appPassword: 'pw',
    })
    expect(res.status).toBe(200)
    expect(syncInstanceById).toHaveBeenCalledWith('inst_new')
  })

  it('triggers a sync for the reconnected (existing) instance', async () => {
    const syncInstanceById = vi.fn(async () => ({ synced: true as const, newMessages: 0 }))
    setGlobalMailboxSyncDeps({ syncInstanceById })
    const { app } = makeApp({ existing: { id: 'inst_existing', provider: 'imap', scope: 'user', connectedEmail: 'maya@harborlane.example' } })
    const res = await request(app).post('/api/connectors/imap/connect').send({
      email: 'maya@harborlane.example', appPassword: 'pw',
    })
    expect(res.status).toBe(200)
    expect(syncInstanceById).toHaveBeenCalledWith('inst_existing')
  })

  it('brings the IDLE watcher up for the new instance when the seam arms watchInstance (workers / OSS process)', async () => {
    const syncInstanceById = vi.fn(async () => ({ synced: true as const, newMessages: 0 }))
    const watchInstance = vi.fn(async () => {})
    setGlobalMailboxSyncDeps({ syncInstanceById, watchInstance })
    const { app } = makeApp()
    const res = await request(app).post('/api/connectors/imap/connect').send({
      email: 'maya@harborlane.example', appPassword: 'pw',
    })
    expect(res.status).toBe(200)
    expect(watchInstance).toHaveBeenCalledWith('inst_new')
  })

  it('connect still succeeds when the sync seam is unarmed', async () => {
    setGlobalMailboxSyncDeps(null)
    const { app, createUserInstance } = makeApp()
    const res = await request(app).post('/api/connectors/imap/connect').send({
      email: 'maya@harborlane.example', appPassword: 'pw',
    })
    expect(res.status).toBe(200)
    expect(createUserInstance).toHaveBeenCalled()
  })
})
