import { describe, it, expect, vi } from 'vitest'
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { createMsTeamsAdapter } from '../msteams/adapter.js'
import { createMsTeamsApi } from '../msteams/api.js'
import { markdownToTeams } from '../msteams/markdown.js'
import { createMsTeamsVerifier, BOT_FRAMEWORK_ISSUER } from '../msteams/verify.js'
import { validateMsTeamsCredentials } from '../msteams/validate.js'

// ── verify.ts (inbound JWT) ────────────────────────────────────

describe('[COMP:channels/msteams-verify] createMsTeamsVerifier', () => {
  const APP_ID = 'bot-app-id'
  const KID = 'test-kid-1'
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: KID, use: 'sig' }

  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  function makeJwt(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: KID, typ: 'JWT' }): string {
    const data = `${b64url(header)}.${b64url(claims)}`
    const sig = cryptoSign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')
    return `${data}.${sig}`
  }
  const now = () => Math.floor(Date.now() / 1000)
  const validClaims = () => ({ iss: BOT_FRAMEWORK_ISSUER, aud: APP_ID, exp: now() + 3600, nbf: now() - 10 })

  function makeFetch() {
    return vi.fn(async (url: string) => {
      if (String(url).includes('openidconfiguration')) {
        return { ok: true, json: async () => ({ jwks_uri: 'https://login.botframework.com/v1/keys' }) } as unknown as Response
      }
      if (String(url).includes('/keys')) {
        return { ok: true, json: async () => ({ keys: [jwk] }) } as unknown as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    })
  }

  it('accepts a valid Bot Connector token', async () => {
    const v = createMsTeamsVerifier({ appId: APP_ID, fetchImpl: makeFetch() as unknown as typeof fetch })
    const result = await v.verifyToken(makeJwt(validClaims()))
    expect(result.valid).toBe(true)
  })

  it('accepts the Authorization header form', async () => {
    const v = createMsTeamsVerifier({ appId: APP_ID, fetchImpl: makeFetch() as unknown as typeof fetch })
    const result = await v.verifyAuthHeader(`Bearer ${makeJwt(validClaims())}`)
    expect(result.valid).toBe(true)
  })

  it('rejects a wrong audience (token for a different bot)', async () => {
    const v = createMsTeamsVerifier({ appId: APP_ID, fetchImpl: makeFetch() as unknown as typeof fetch })
    const result = await v.verifyToken(makeJwt({ ...validClaims(), aud: 'some-other-app' }))
    expect(result).toMatchObject({ valid: false, reason: 'bad audience' })
  })

  it('rejects a wrong issuer', async () => {
    const v = createMsTeamsVerifier({ appId: APP_ID, fetchImpl: makeFetch() as unknown as typeof fetch })
    const result = await v.verifyToken(makeJwt({ ...validClaims(), iss: 'https://evil.example.com' }))
    expect(result).toMatchObject({ valid: false, reason: 'bad issuer' })
  })

  it('rejects an expired token (beyond the 5-min skew)', async () => {
    const v = createMsTeamsVerifier({ appId: APP_ID, fetchImpl: makeFetch() as unknown as typeof fetch })
    const result = await v.verifyToken(makeJwt({ ...validClaims(), exp: now() - 1000 }))
    expect(result).toMatchObject({ valid: false, reason: 'expired' })
  })

  it('rejects a tampered payload (bad signature)', async () => {
    const v = createMsTeamsVerifier({ appId: APP_ID, fetchImpl: makeFetch() as unknown as typeof fetch })
    const token = makeJwt(validClaims())
    const [h, , s] = token.split('.')
    // Re-encode a different payload but keep the original signature.
    const tampered = `${h}.${b64url({ ...validClaims(), aud: APP_ID, extra: 'x' })}.${s}`
    const result = await v.verifyToken(tampered)
    expect(result).toMatchObject({ valid: false, reason: 'bad signature' })
  })

  it('rejects a non-RS256 alg', async () => {
    const v = createMsTeamsVerifier({ appId: APP_ID, fetchImpl: makeFetch() as unknown as typeof fetch })
    const result = await v.verifyToken(makeJwt(validClaims(), { alg: 'none', kid: KID }))
    expect(result.valid).toBe(false)
  })

  it('caches the JWKS across verifications (no refetch per call)', async () => {
    const f = makeFetch()
    const v = createMsTeamsVerifier({ appId: APP_ID, fetchImpl: f as unknown as typeof fetch })
    await v.verifyToken(makeJwt(validClaims()))
    await v.verifyToken(makeJwt(validClaims()))
    // First verify: 1 metadata + 1 jwks. Second: served from cache. Total 2.
    expect(f).toHaveBeenCalledTimes(2)
  })
})

// ── api.ts (token mint + serviceUrl send) ──────────────────────

describe('[COMP:channels/msteams] createMsTeamsApi token + send', () => {
  function tokenFetch(extra?: (url: string, init?: RequestInit) => void) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      extra?.(String(url), init)
      if (String(url).includes('/oauth2/v2.0/token')) {
        return { ok: true, json: async () => ({ access_token: 'tok123', expires_in: 3600 }) } as unknown as Response
      }
      return { ok: true, json: async () => ({ id: 'act-1' }) } as unknown as Response
    })
  }

  it('mints a token against the tenant-scoped endpoint with the connector scope', async () => {
    let tokenBody = ''
    const f = tokenFetch((url, init) => {
      if (url.includes('/oauth2/v2.0/token')) tokenBody = String(init?.body ?? '')
    })
    const api = createMsTeamsApi({ appId: 'app', appPassword: 'sec', tenantId: 'tid-9', fetchImpl: f as unknown as typeof fetch })
    const tok = await api.getToken()
    expect(tok).toBe('tok123')
    const call = f.mock.calls.find((c) => String(c[0]).includes('/oauth2/v2.0/token'))!
    expect(String(call[0])).toBe('https://login.microsoftonline.com/tid-9/oauth2/v2.0/token')
    expect(tokenBody).toContain('grant_type=client_credentials')
    expect(tokenBody).toContain('scope=https%3A%2F%2Fapi.botframework.com%2F.default')
  })

  it('caches the token across sends', async () => {
    const f = tokenFetch()
    const api = createMsTeamsApi({ appId: 'app', appPassword: 'sec', tenantId: 't', serviceUrl: 'https://smba.test/emea/', fetchImpl: f as unknown as typeof fetch })
    await api.sendActivity('conv1', { type: 'message', text: 'a' })
    await api.sendActivity('conv1', { type: 'message', text: 'b' })
    expect(f.mock.calls.filter((c) => String(c[0]).includes('/oauth2/v2.0/token')).length).toBe(1)
  })

  it('POSTs the activity to the serviceUrl with a Bearer token (trailing slash stripped)', async () => {
    const f = tokenFetch()
    const api = createMsTeamsApi({ appId: 'app', appPassword: 'sec', tenantId: 't', serviceUrl: 'https://smba.test/emea/', fetchImpl: f as unknown as typeof fetch })
    const { id } = await api.sendActivity('conv1', { type: 'message', text: 'hi' })
    expect(id).toBe('act-1')
    const send = f.mock.calls.find((c) => String(c[0]).includes('/v3/conversations/'))!
    expect(String(send[0])).toBe('https://smba.test/emea/v3/conversations/conv1/activities')
    const headers = (send[1] as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok123')
  })

  it('surfaces the AAD error string on a bad secret', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_client', error_description: 'AADSTS7000215: bad secret' }) }) as unknown as Response)
    const api = createMsTeamsApi({ appId: 'app', appPassword: 'bad', tenantId: 't', fetchImpl: f as unknown as typeof fetch })
    await expect(api.getToken()).rejects.toThrow('AADSTS7000215')
  })

  it('throws when sending without a serviceUrl', async () => {
    const f = tokenFetch()
    const api = createMsTeamsApi({ appId: 'app', appPassword: 'sec', tenantId: 't', fetchImpl: f as unknown as typeof fetch })
    await expect(api.sendActivity('conv1', { type: 'message', text: 'x' })).rejects.toThrow(/serviceUrl/)
  })
})

// ── validate.ts ────────────────────────────────────────────────

describe('[COMP:channels/msteams] validateMsTeamsCredentials', () => {
  it('returns identity on a successful token mint', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) }) as unknown as Response)
    const info = await validateMsTeamsCredentials({ appId: 'a', appPassword: 's', tenantId: 'tid', fetchImpl: f as unknown as typeof fetch })
    expect(info).toEqual({ appId: 'a', tenantId: 'tid', botId: '28:a' })
  })

  it('throws on invalid credentials', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_client' }) }) as unknown as Response)
    await expect(
      validateMsTeamsCredentials({ appId: 'a', appPassword: 'bad', tenantId: 'tid', fetchImpl: f as unknown as typeof fetch }),
    ).rejects.toThrow('invalid_client')
  })
})

// ── adapter.ts parseIncoming ───────────────────────────────────

describe('[COMP:channels/msteams] createMsTeamsAdapter parseIncoming', () => {
  const adapter = createMsTeamsAdapter({ appId: 'app', appPassword: 'sec', tenantId: 't', botId: '28:app' })

  const base = {
    type: 'message',
    id: 'a1',
    from: { id: '29:user' },
    recipient: { id: '28:app' },
    timestamp: '2026-07-22T00:00:00.000Z',
  }

  it('parses a 1:1 personal message (always answered)', () => {
    const r = adapter.parseIncoming({ ...base, conversation: { id: 'conv-dm', conversationType: 'personal' }, text: 'hello bot' })
    expect(r).toMatchObject({ userId: '29:user', channelId: 'conv-dm', text: 'hello bot', isGroupChat: false, isMentioned: false, messageId: 'a1' })
  })

  it('drops a channel message with no @mention', () => {
    const r = adapter.parseIncoming({ ...base, conversation: { id: 'conv-c', conversationType: 'channel' }, text: 'just chatting' })
    expect(r).toBeNull()
  })

  it('answers a channel message that @mentions the bot, stripping the mention tag', () => {
    const r = adapter.parseIncoming({
      ...base,
      conversation: { id: 'conv-c', conversationType: 'channel' },
      text: '<at>Brian</at> what time is it',
      entities: [{ type: 'mention', mentioned: { id: '28:app' }, text: '<at>Brian</at>' }],
    })
    expect(r).not.toBeNull()
    expect(r!.text).toBe('what time is it')
    expect(r!.isGroupChat).toBe(true)
    expect(r!.isMentioned).toBe(true)
  })

  it('ignores the bot\'s own outbound activity (loop protection)', () => {
    const r = adapter.parseIncoming({ ...base, from: { id: '28:app' }, conversation: { id: 'conv-dm', conversationType: 'personal' }, text: 'echo' })
    expect(r).toBeNull()
  })

  it('returns null for non-message activities', () => {
    expect(adapter.parseIncoming({ type: 'typing', conversation: { id: 'c' }, from: { id: 'u' } })).toBeNull()
    expect(adapter.parseIncoming({ type: 'conversationUpdate', conversation: { id: 'c' }, from: { id: 'u' } })).toBeNull()
  })

  it('extracts a Teams file attachment with its pre-authorized download url', () => {
    const r = adapter.parseIncoming({
      ...base,
      conversation: { id: 'conv-dm', conversationType: 'personal' },
      text: '',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.teams.file.download.info',
          name: 'q1.pdf',
          content: { downloadUrl: 'https://sharepoint.test/q1.pdf', fileType: 'pdf' },
        },
      ],
    })
    expect(r!.files).toEqual([{ url: 'https://sharepoint.test/q1.pdf', mimeType: 'application/pdf', name: 'q1.pdf' }])
  })

  it('calls onMessage from handleActivity', () => {
    const onMessage = vi.fn()
    const a = createMsTeamsAdapter({ appId: 'app', appPassword: 's', tenantId: 't', botId: '28:app', onMessage })
    a.handleActivity({ ...base, conversation: { id: 'conv-dm', conversationType: 'personal' }, text: 'hi' })
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onMessage.mock.calls[0][0]).toMatchObject({ text: 'hi', userId: '29:user' })
  })
})

// ── adapter.ts send / status / interface ───────────────────────

describe('[COMP:channels/msteams] adapter send + interface', () => {
  function sendFetch() {
    return vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes('/oauth2/v2.0/token')) {
        return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) } as unknown as Response
      }
      return { ok: true, json: async () => ({ id: 'act-1' }) } as unknown as Response
    })
  }

  it('declares the expected ChannelAdapter shape', () => {
    const a = createMsTeamsAdapter({ appId: 'app', appPassword: 's', tenantId: 't' })
    expect(a.type).toBe('msteams')
    expect(a.supportsMarkdown).toBe(true)
    expect(a.supportsMessageEdit).toBe(true)
    expect(a.drainDelayMs).toBe(2000)
    expect(a.maxMessageLength).toBeGreaterThan(0)
  })

  it('sends a markdown message as a Bot Framework activity and returns its id', async () => {
    const f = sendFetch()
    const a = createMsTeamsAdapter({ appId: 'app', appPassword: 's', tenantId: 't', serviceUrl: 'https://smba.test/emea/', fetchImpl: f as unknown as typeof fetch })
    const id = await a.sendMessage('conv1', { text: '# Title', format: 'markdown' })
    expect(id).toBe('act-1')
    const send = f.mock.calls.find((c) => String(c[0]).includes('/v3/conversations/'))!
    const body = JSON.parse((send[1] as RequestInit).body as string)
    expect(body.type).toBe('message')
    expect(body.textFormat).toBe('markdown')
    expect(body.text).toBe('**Title**') // header flattened to bold
  })

  it('does not send an empty message', async () => {
    const f = sendFetch()
    const a = createMsTeamsAdapter({ appId: 'app', appPassword: 's', tenantId: 't', serviceUrl: 'https://smba.test/', fetchImpl: f as unknown as typeof fetch })
    const id = await a.sendMessage('conv1', { text: '   ' })
    expect(id).toBe('')
    expect(f.mock.calls.some((c) => String(c[0]).includes('/v3/conversations/'))).toBe(false)
  })

  it('sendStatus posts a real message and returns its id (edit-in-place model)', async () => {
    const f = sendFetch()
    const a = createMsTeamsAdapter({ appId: 'app', appPassword: 's', tenantId: 't', serviceUrl: 'https://smba.test/emea', fetchImpl: f as unknown as typeof fetch })
    const id = await a.sendStatus('conv1', 'Searching the web...')
    expect(id).toBe('act-1')
  })
})

// ── markdown.ts ────────────────────────────────────────────────

describe('[COMP:channels/msteams-markdown] markdownToTeams', () => {
  it('flattens headers to bold', () => {
    expect(markdownToTeams('# Title')).toBe('**Title**')
    expect(markdownToTeams('### Deep')).toBe('**Deep**')
  })

  it('converts tables to key-value blocks', () => {
    const out = markdownToTeams('| Model | Speed |\n|---|---|\n| A | fast |')
    expect(out).toContain('**Model:** A')
    expect(out).toContain('**Speed:** fast')
  })

  it('drops horizontal rules', () => {
    expect(markdownToTeams('a\n\n---\n\nb')).not.toContain('---')
  })

  it('protects code spans from rewriting', () => {
    expect(markdownToTeams('`# not a header`')).toBe('`# not a header`')
    const fenced = markdownToTeams('```\n# in code\n---\n```')
    expect(fenced).toContain('# in code')
    expect(fenced).toContain('---')
  })

  it('passes bold, italic, links, and lists through', () => {
    const src = 'See **bold**, _italic_, [link](https://x), and\n- one\n- two'
    const out = markdownToTeams(src)
    expect(out).toContain('**bold**')
    expect(out).toContain('_italic_')
    expect(out).toContain('[link](https://x)')
    expect(out).toContain('- one')
  })
})
