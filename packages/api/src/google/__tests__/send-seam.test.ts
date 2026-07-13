import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  refreshGoogleAccessToken: vi.fn(),
  sendGmailMessage: vi.fn(),
}))
vi.mock('../../connector-config.js', () => ({
  getConnectorConfig: vi.fn(),
}))

import { createGmailSendSeam } from '../send-seam.js'
import { refreshGoogleAccessToken, sendGmailMessage } from '../client.js'
import { getConnectorConfig } from '../../connector-config.js'

const mockRefresh = vi.mocked(refreshGoogleAccessToken)
const mockSend = vi.mocked(sendGmailMessage)
const mockConfig = vi.mocked(getConnectorConfig)

const USER = 'u-1'

function makeSeam(creds: { primary?: string | null; instance?: string | null }) {
  return createGmailSendSeam({
    connectorStore: {
      getCredentials: vi.fn(async () =>
        creds.primary === null || creds.primary === undefined
          ? null
          : { client_id: 'ignored', client_secret: creds.primary },
      ),
    },
    connectorInstanceStore: {
      getCredentials: vi.fn(async () =>
        creds.instance === null || creds.instance === undefined
          ? null
          : { client_id: 'ignored', client_secret: creds.instance },
      ),
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockConfig.mockReturnValue({ clientId: 'app-id', clientSecret: 'app-secret' } as never)
  mockRefresh.mockResolvedValue('access-token-1')
  mockSend.mockResolvedValue({ id: 'gm-1', threadId: 'th-1' })
})

describe('[COMP:api/gmail-send-seam] acquireGmailSender', () => {
  it('refuses when Google OAuth is not configured', async () => {
    mockConfig.mockReturnValue(undefined)
    const result = await makeSeam({ primary: 'rt-1' })({ userId: USER })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('not configured')
  })

  it('refuses when the primary gmail connector is not connected', async () => {
    const result = await makeSeam({ primary: null })({ userId: USER })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('Connect Gmail')
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  it('resolves the primary refresh token (the client_secret storage quirk) and sends with the refreshed access token', async () => {
    const result = await makeSeam({ primary: 'refresh-token-primary' })({ userId: USER })
    expect(result.ok).toBe(true)
    expect(mockRefresh).toHaveBeenCalledWith('refresh-token-primary', 'app-id', 'app-secret')
    if (result.ok) {
      const sent = await result.send({ to: 'a@b.co', subject: 'Hi', body: 'Body' })
      expect(sent).toEqual({ id: 'gm-1', threadId: 'th-1' })
      expect(mockSend).toHaveBeenCalledWith('access-token-1', {
        to: 'a@b.co',
        subject: 'Hi',
        body: 'Body',
      })
    }
  })

  it('resolves an instance-scoped account when instanceId is passed', async () => {
    const seam = makeSeam({ primary: 'rt-primary', instance: 'rt-instance' })
    const result = await seam({ userId: USER, instanceId: 'inst-1' })
    expect(result.ok).toBe(true)
    expect(mockRefresh).toHaveBeenCalledWith('rt-instance', 'app-id', 'app-secret')
  })

  it('refuses an instance the user cannot see', async () => {
    const seam = makeSeam({ primary: 'rt-primary', instance: null })
    const result = await seam({ userId: USER, instanceId: 'inst-1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('instance')
  })
})
