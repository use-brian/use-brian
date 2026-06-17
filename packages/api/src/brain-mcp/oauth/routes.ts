/**
 * OAuth 2.1 routes mounted at `/api/brain/oauth`.
 *
 *   POST /register         RFC 7591 dynamic client registration
 *   GET  /authorize        OAuth 2.1 authorization endpoint — redirects to the
 *                          web app's consent page with a signed request blob
 *   GET  /consent          (JWT-authed) the web app calls this to decode the
 *                          signed request and read the workspace list
 *   POST /consent          (JWT-authed) the web app calls this when the user
 *                          clicks Allow — returns the final redirect URL
 *   POST /token            OAuth 2.1 token endpoint (authorization_code +
 *                          refresh_token grants, PKCE-required)
 *
 * Auth posture:
 *   - /register, /authorize, /token are PUBLIC (no JWT). They are protocol
 *     endpoints third-party clients hit directly.
 *   - /consent is JWT-authed via `requireAuth` mounted by the caller (see
 *     apps/api/src/index.ts). The web app's authFetch attaches the user's
 *     access_token cookie.
 *
 * Component tag: [COMP:api/brain-oauth].
 * Spec: docs/architecture/features/programmatic-access.md → "OAuth 2.1 mode".
 */

import express, { Router, type Request, type RequestHandler, type Response } from 'express'
import { z } from 'zod'
import type { OAuthClientStore, OAuthTokenEndpointAuthMethod } from '../../db/oauth-client-store.js'
import type { OAuthAuthorizationStore, OAuthScope } from '../../db/oauth-authorization-store.js'
import { parseOAuthBearerToken } from '../../db/oauth-authorization-store.js'
import type { WorkspaceStore } from '../../db/workspace-store.js'
import { queryWithRLS } from '../../db/client.js'
import { verifySecret } from '../../db/api-key-store.js'
import {
  signConsentRequest,
  verifyConsentRequest,
  CONSENT_REQUEST_TTL_SECONDS,
  type OAuthConsentRequest,
} from './codes.js'

export type OAuthRoutesOptions = {
  clientStore: OAuthClientStore
  authorizationStore: OAuthAuthorizationStore
  workspaceStore: WorkspaceStore
  /** HMAC secret for the consent-request blob. */
  signingSecret: string
  /** Web app origin used to build the consent-page URL. */
  webAppUrl: string
  /**
   * JWT auth middleware applied to the /consent endpoints only — the web
   * app is the sole caller there and must attach the user's access_token.
   * The other endpoints (register/authorize/token) are public protocol
   * surfaces that handle their own auth.
   */
  requireAuth: RequestHandler
}

// ── Schemas ─────────────────────────────────────────────────────

const RegisterBody = z
  .object({
    redirect_uris: z.array(z.string().url()).min(1).max(10),
    client_name: z.string().min(1).max(200).optional(),
    client_uri: z.string().url().optional(),
    token_endpoint_auth_method: z
      .enum(['none', 'client_secret_post'])
      .default('none'),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
  })
  .passthrough() // RFC 7591 lets clients send arbitrary additional metadata

const ConsentDecisionBody = z
  .object({
    req: z.string().min(1),
    workspaceId: z.string().uuid(),
    decision: z.enum(['allow', 'deny']),
    /**
     * The scope the user actually granted, optionally narrower than what
     * the client requested. If absent, defaults to what was requested
     * (preserving the client's ask).
     */
    grantedScope: z.enum(['read', 'read_write']).optional(),
  })
  .strict()

const TokenBodyAuthCode = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1),
  code_verifier: z.string().min(43).max(128),
  redirect_uri: z.string().url(),
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
})

const TokenBodyRefresh = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string().min(1),
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
})

// ── Helpers ─────────────────────────────────────────────────────

function buildErrorRedirect(redirectUri: string, error: string, state: string | null): string {
  try {
    const u = new URL(redirectUri)
    u.searchParams.set('error', error)
    if (state) u.searchParams.set('state', state)
    return u.toString()
  } catch {
    return redirectUri
  }
}

function buildSuccessRedirect(redirectUri: string, code: string, state: string | null): string {
  try {
    const u = new URL(redirectUri)
    u.searchParams.set('code', code)
    if (state) u.searchParams.set('state', state)
    return u.toString()
  } catch {
    return redirectUri
  }
}

async function authenticateClient(
  store: OAuthClientStore,
  clientId: string,
  clientSecret: string | undefined,
): Promise<{ authMethod: OAuthTokenEndpointAuthMethod } | null> {
  const client = await store.getByClientIdSystem(clientId)
  if (!client) return null
  if (client.revokedAt) return null
  if (client.tokenEndpointAuthMethod === 'none') {
    // Public client — PKCE alone authenticates.
    return { authMethod: 'none' }
  }
  // Confidential client — must present client_secret.
  if (!clientSecret || !client.clientSecretHash) return null
  const ok = await verifySecret(clientSecret, client.clientSecretHash)
  if (!ok) return null
  return { authMethod: 'client_secret_post' }
}

// ── Router ──────────────────────────────────────────────────────

export function oauthRoutes(opts: OAuthRoutesOptions): Router {
  const router = Router()

  // ── POST /register — RFC 7591 dynamic client registration ──────
  router.post('/register', async (req, res) => {
    const parsed = RegisterBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: parsed.error.message,
      })
      return
    }
    try {
      const created = await opts.clientStore.register({
        clientName: parsed.data.client_name ?? null,
        clientUri: parsed.data.client_uri ?? null,
        redirectUris: parsed.data.redirect_uris,
        tokenEndpointAuthMethod: parsed.data.token_endpoint_auth_method,
      })
      // RFC 7591 §3.2.1 response shape.
      res.status(201).json({
        client_id: created.clientId,
        ...(created.clientSecret ? { client_secret: created.clientSecret } : {}),
        client_id_issued_at: Math.floor(created.createdAt.getTime() / 1000),
        redirect_uris: created.redirectUris,
        token_endpoint_auth_method: created.tokenEndpointAuthMethod,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        ...(created.clientName ? { client_name: created.clientName } : {}),
        ...(created.clientUri ? { client_uri: created.clientUri } : {}),
      })
    } catch (err) {
      console.error('[brain-oauth] register failed:', err)
      res.status(500).json({ error: 'server_error' })
    }
  })

  // ── GET /authorize — kicks off the consent flow ────────────────
  router.get('/authorize', async (req, res) => {
    const clientId = String(req.query.client_id ?? '')
    const redirectUri = String(req.query.redirect_uri ?? '')
    const responseType = String(req.query.response_type ?? '')
    const codeChallenge = String(req.query.code_challenge ?? '')
    const codeChallengeMethod = String(req.query.code_challenge_method ?? '')
    const scopeRaw = String(req.query.scope ?? 'read_write')
    const state = typeof req.query.state === 'string' ? req.query.state : null

    if (!clientId || !redirectUri) {
      // No safe redirect — render an error directly.
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    const client = await opts.clientStore.getByClientIdSystem(clientId)
    if (!client || client.revokedAt) {
      res.status(400).json({ error: 'invalid_client' })
      return
    }
    if (!client.redirectUris.includes(redirectUri)) {
      // Per RFC 6749 §3.1.2.4, redirect_uri mismatch is reported to the
      // resource owner directly, NOT via redirect (could be an attack).
      res.status(400).json({ error: 'invalid_redirect_uri' })
      return
    }
    if (responseType !== 'code') {
      res.redirect(buildErrorRedirect(redirectUri, 'unsupported_response_type', state))
      return
    }
    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      res.redirect(buildErrorRedirect(redirectUri, 'invalid_request', state))
      return
    }
    const scope: OAuthScope = scopeRaw === 'read' ? 'read' : 'read_write'

    const consentReq: OAuthConsentRequest = {
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod: 'S256',
      scope,
      state,
      exp: Math.floor(Date.now() / 1000) + CONSENT_REQUEST_TTL_SECONDS,
    }
    const signed = signConsentRequest(consentReq, opts.signingSecret)

    const consentUrl = new URL('/oauth/authorize', opts.webAppUrl)
    consentUrl.searchParams.set('req', signed)
    res.redirect(consentUrl.toString())
  })

  // ── GET /consent — web app decodes the signed request blob ─────
  // JWT-authed. Returns the consent UI's payload: which app, what
  // scope, which workspaces the user can pick.
  router.get('/consent', opts.requireAuth, async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    const signed = String(req.query.req ?? '')
    const consentReq = verifyConsentRequest(signed, opts.signingSecret)
    if (!consentReq) {
      res.status(400).json({ error: 'invalid_or_expired_request' })
      return
    }
    const client = await opts.clientStore.getByClientIdSystem(consentReq.clientId)
    if (!client || client.revokedAt) {
      res.status(400).json({ error: 'invalid_client' })
      return
    }
    // Workspaces the user can grant against — must be owner/admin to issue
    // brain credentials. RLS scopes the workspace_members join to rows the
    // user can see; the role filter is the per-row admin gate.
    const eligible = await queryWithRLS<{ id: string; name: string }>(
      userId,
      `SELECT w.id, w.name
       FROM workspaces w
       JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = $1
       WHERE wm.role IN ('owner', 'admin')
       ORDER BY w.is_personal DESC, w.created_at ASC`,
      [userId],
    )
    res.json({
      clientName: client.clientName,
      clientUri: client.clientUri,
      scope: consentReq.scope,
      workspaces: eligible.rows,
    })
  })

  // ── POST /consent — user clicked Allow or Deny ─────────────────
  router.post('/consent', opts.requireAuth, async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    const parsed = ConsentDecisionBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    const consentReq = verifyConsentRequest(parsed.data.req, opts.signingSecret)
    if (!consentReq) {
      res.status(400).json({ error: 'invalid_or_expired_request' })
      return
    }

    if (parsed.data.decision === 'deny') {
      const url = buildErrorRedirect(consentReq.redirectUri, 'access_denied', consentReq.state)
      res.json({ redirectUrl: url })
      return
    }

    // Enforce admin role for the chosen workspace.
    const role = await opts.workspaceStore.getRole(userId, parsed.data.workspaceId)
    if (role !== 'owner' && role !== 'admin') {
      res.status(403).json({ error: 'workspace_admin_required' })
      return
    }

    // Validate the granted scope is a subset of what was requested. If the
    // client asked for `read`, the user cannot grant `read_write` (would
    // surprise the client). If the client asked for `read_write`, the user
    // can downgrade to `read`. This is the standard OAuth consent pattern.
    const requested = consentReq.scope
    const grantedScope = parsed.data.grantedScope ?? requested
    if (grantedScope === 'read_write' && requested === 'read') {
      res.status(400).json({ error: 'scope_above_requested' })
      return
    }

    try {
      const { codePlaintext } = await opts.authorizationStore.createGrantWithCode({
        clientId: consentReq.clientId,
        userId,
        workspaceId: parsed.data.workspaceId,
        scope: grantedScope,
        codeChallenge: consentReq.codeChallenge,
        redirectUri: consentReq.redirectUri,
      })
      const url = buildSuccessRedirect(consentReq.redirectUri, codePlaintext, consentReq.state)
      res.json({ redirectUrl: url })
    } catch (err) {
      console.error('[brain-oauth] consent failed:', err)
      res.status(500).json({ error: 'server_error' })
    }
  })

  // ── POST /token — code exchange OR refresh rotation ────────────
  //
  // RFC 6749 §4.1.3 mandates `application/x-www-form-urlencoded` on this
  // endpoint. Most MCP clients (claude.ai, Claude Desktop) follow the spec.
  // The global app.use(express.json()) on apps/api won't parse form bodies,
  // so we attach a per-route urlencoded parser here — JSON callers still
  // work because the global json() middleware will have already populated
  // req.body when the Content-Type is application/json.
  router.post('/token', express.urlencoded({ extended: false }), async (req, res) => {
    // Per RFC 6749 §4.1.3 the body is application/x-www-form-urlencoded,
    // but plenty of MCP clients send JSON. We accept either — express's
    // urlencoded + json parsers handle the dispatch.
    const grantType = req.body?.grant_type
    if (grantType === 'authorization_code') {
      const parsed = TokenBodyAuthCode.safeParse(req.body)
      if (!parsed.success) {
        console.warn('[brain-oauth] /token authorization_code parse failed:', parsed.error.message)
        res.status(400).json({ error: 'invalid_request', error_description: parsed.error.message })
        return
      }
      const clientAuth = await authenticateClient(
        opts.clientStore,
        parsed.data.client_id,
        parsed.data.client_secret,
      )
      if (!clientAuth) {
        console.warn('[brain-oauth] /token invalid_client:', parsed.data.client_id)
        res.status(401).json({ error: 'invalid_client' })
        return
      }
      const codeParts = parseOAuthBearerToken(parsed.data.code, 'oac')
      if (!codeParts) {
        console.warn('[brain-oauth] /token malformed code')
        res.status(400).json({ error: 'invalid_grant' })
        return
      }
      const result = await opts.authorizationStore.exchangeCodeForTokens({
        codeId: codeParts.id,
        codeSecret: codeParts.secret,
        codeVerifier: parsed.data.code_verifier,
        redirectUri: parsed.data.redirect_uri,
        clientId: parsed.data.client_id,
      })
      if (!result) {
        console.warn(
          '[brain-oauth] /token exchange failed for code id %s (client %s, redirect %s)',
          codeParts.id,
          parsed.data.client_id,
          parsed.data.redirect_uri,
        )
        res.status(400).json({ error: 'invalid_grant' })
        return
      }
      opts.clientStore.touchLastUsedAt(parsed.data.client_id).catch(() => {})
      res.json({
        access_token: result.tokens.accessToken,
        refresh_token: result.tokens.refreshToken,
        token_type: 'Bearer',
        expires_in: result.tokens.expiresIn,
        scope: result.row.scope,
      })
      return
    }
    if (grantType === 'refresh_token') {
      const parsed = TokenBodyRefresh.safeParse(req.body)
      if (!parsed.success) {
        console.warn('[brain-oauth] /token refresh_token parse failed:', parsed.error.message)
        res.status(400).json({ error: 'invalid_request', error_description: parsed.error.message })
        return
      }
      const clientAuth = await authenticateClient(
        opts.clientStore,
        parsed.data.client_id,
        parsed.data.client_secret,
      )
      if (!clientAuth) {
        console.warn('[brain-oauth] /token refresh invalid_client:', parsed.data.client_id)
        res.status(401).json({ error: 'invalid_client' })
        return
      }
      const refreshParts = parseOAuthBearerToken(parsed.data.refresh_token, 'ort')
      if (!refreshParts) {
        console.warn('[brain-oauth] /token refresh malformed token')
        res.status(400).json({ error: 'invalid_grant' })
        return
      }
      const result = await opts.authorizationStore.rotateOnRefresh({
        refreshId: refreshParts.id,
        refreshSecret: refreshParts.secret,
        clientId: parsed.data.client_id,
      })
      if (!result) {
        console.warn(
          '[brain-oauth] /token refresh rotation failed for id %s (client %s)',
          refreshParts.id,
          parsed.data.client_id,
        )
        res.status(400).json({ error: 'invalid_grant' })
        return
      }
      opts.clientStore.touchLastUsedAt(parsed.data.client_id).catch(() => {})
      res.json({
        access_token: result.tokens.accessToken,
        refresh_token: result.tokens.refreshToken,
        token_type: 'Bearer',
        expires_in: result.tokens.expiresIn,
        scope: result.row.scope,
      })
      return
    }
    res.status(400).json({ error: 'unsupported_grant_type' })
  })

  return router
}
