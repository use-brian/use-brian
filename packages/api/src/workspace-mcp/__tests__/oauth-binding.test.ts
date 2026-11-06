import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { signConsentRequest, verifyConsentRequest, type OAuthConsentRequest } from '../../brain-mcp/oauth/codes.js'
import { oauthMetadataRoutes } from '../../brain-mcp/oauth/metadata.js'
const assistantId = '00000000-0000-4000-8000-000000000011'
const base: OAuthConsentRequest = { clientId: 'fictional-client', redirectUri: 'https://client.example/callback',
  codeChallenge: 'a'.repeat(43), codeChallengeMethod: 'S256', scope: 'read_write', state: null, exp: Math.floor(Date.now() / 1000) + 600 }
describe('[COMP:api/workspace-mcp] OAuth resource binding', () => {
  it('preserves the exact assistant in signed consent and rejects mixed audiences', () => {
    const secret = 'fictional-signing-secret'
    const signed = { ...base, audience: 'assistant' as const, assistantId }
    expect(verifyConsentRequest(signConsentRequest(signed, secret), secret)).toEqual(signed)
    for (const invalid of [{ ...signed, assistantId: undefined }, { ...signed, assistantId: 'not-an-id' },
      { ...signed, applicationId: assistantId }, { ...base, assistantId }, { ...signed, audience: 'brain' as const }]) {
      expect(verifyConsentRequest(signConsentRequest(invalid, secret), secret)).toBeNull()
    }
  })
  it('advertises only the assistant-specific resource and protocol endpoints when enabled', async () => {
    const app = express().use(oauthMetadataRoutes({ apiUrl: 'https://api.example', webUrl: 'https://docs.example', assistantWorkspaceOAuth: true }))
    const resource = await request(app).get(`/.well-known/oauth-protected-resource/api/v1/assistants/${assistantId}/mcp`)
    const issuer = `https://api.example/api/v1/assistants/${assistantId}`
    expect(resource.body).toMatchObject({ resource: `${issuer}/mcp`, authorization_servers: [issuer] })
    const server = await request(app).get(`/.well-known/oauth-authorization-server/api/v1/assistants/${assistantId}`)
    expect(server.body).toMatchObject({ issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, code_challenge_methods_supported: ['S256'] })
    expect((await request(app).get('/.well-known/oauth-protected-resource/api/v1/assistants/not-an-id/mcp')).status).toBe(404)
  })
  it('does not advertise an authorization server before its routes are enabled', async () => {
    const app = express().use(oauthMetadataRoutes({ apiUrl: 'https://api.example', webUrl: 'https://docs.example' }))
    expect((await request(app).get(`/.well-known/oauth-authorization-server/api/v1/assistants/${assistantId}`)).status).toBe(404)
  })
})
