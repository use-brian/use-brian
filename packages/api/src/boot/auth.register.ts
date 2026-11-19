/**
 * Background runtime resolvers, identity stores and the auth routes.
 *
 * Boot register module registerAuth: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`AuthScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { recordDeliveredTelegramConversation } from '../telegram-conversation-context.js'
import { recordDeliveredTelegramMessage } from '../channel-recording.js'
import { createWorkspaceStore } from '../db/workspace-store.js'
import { configureTelegramTextDeliveryObserver, createTelegramApi } from '@use-brian/channels'
import { findUserByEmail, findUserById, findUserByAuthProvider } from '../db/users.js'
import { deploymentProfile } from '../edition.js'
import { requireOutpostAuthPortal, createEmailAdmission } from '../auth/email-admission.js'
import { validateOutpostAuthConfig } from '../auth/outpost-auth-config.js'
import { authRoutes } from '../routes/auth.js'
import { adoptVerifiedLocalOwner } from '../db/outpost-owner-adoption.js'
import { isLocalDevEnv, devAuthRoutes } from '../routes/dev-auth.js'
import { isSelfHostedOssEnv, localSessionRoutes } from '../routes/local-session.js'
import { createDbMagicLinkStore } from '../db/magic-link-store.js'
import { createSmtpClient, createSmtpTransport } from '../email/smtp-client.js'
import { createDbChannelUserStore } from '../db/channel-user-store.js'
import { createDbLinkedAccountStore } from '../db/linked-accounts.js'
import { createLinkedIdentityStore } from '../db/linked-identity-store.js'
import { createChannelRouteStore } from '../db/channel-route-store.js'
import { createDbLinkCodeStore } from '../db/link-codes.js'
import { configureBriefTurnContext, resolveBriefTurn } from '../briefs/context.js'
import { createDbCompartmentStore } from '../db/compartment-store.js'
import { createDbOAuthClientStore } from '../db/oauth-client-store.js'
import { createDbMobileAuthStore } from '../db/mobile-auth-store.js'
import { createDbDesktopAuthStore } from '../db/desktop-auth-store.js'
import { createDbOAuthAuthorizationStore } from '../db/oauth-authorization-store.js'
import { query } from '../db/client.js'
import type { EmailAuth } from '../boot.js'
import type { AuthScope } from './scope.js'

export async function registerAuth(scope: AuthScope) {
  const { env, app, ports, resolveWorkspaceCustomLlm } = scope
  configureTelegramTextDeliveryObserver(async delivery => {
    await Promise.all([recordDeliveredTelegramMessage(delivery),recordDeliveredTelegramConversation(delivery)])
  })
  // Accepted Brief grounding + revision boundary for every runner's prepare stage.
  configureBriefTurnContext(resolveBriefTurn)
  const resolveBackgroundRuntime = async (workspaceId: string | null | undefined) => {
    if (!workspaceId) return null
    // A denial must not look like a missing custom route. That would let
    // callers fall back to the application provider.
    await ports.backgroundInferencePolicy?.assertAllowed(workspaceId)
    return resolveWorkspaceCustomLlm({
      workspaceId,
      requestedTier: 'standard',
      allowDefault: true,
      allowAnyDefault: true,
      // Exact managed routes are a user-facing tier choice. Preserve the
      // existing internal/background lane; custom BYO defaults keep their
      // historical behavior here.
      allowManagedRoutes: false,
    })
  }
  const workspaceForAssistant = async (assistantId: string): Promise<string | null> => {
    if (!assistantId) return null
    const result = await query<{ workspaceId: string }>(
      `SELECT workspace_id AS "workspaceId" FROM assistants WHERE id = $1`,
      [assistantId],
    )
    return result.rows[0]?.workspaceId ?? null
  }
  const ownerForWorkspace = async (workspaceId: string): Promise<string | null> => {
    const result = await query<{ ownerUserId: string }>(
      `SELECT owner_user_id AS "ownerUserId" FROM workspaces WHERE id = $1`,
      [workspaceId],
    )
    return result.rows[0]?.ownerUserId ?? null
  }
  const compartmentStore = createDbCompartmentStore()
  const oauthClientStore = createDbOAuthClientStore()
  const oauthAuthorizationStore = createDbOAuthAuthorizationStore()
  const desktopAuthStore = createDbDesktopAuthStore()
  // Channel shadow-identity resolution (channel_user_cache) — shared by the
  // open BYO webhooks mounted below and the closed official-bot/WhatsApp
  // routes (via BootContext).
  const channelUserStore = createDbChannelUserStore()

  const channelRouteStore = createChannelRouteStore()
  const linkedAccountStore = createDbLinkedAccountStore()
  const linkedIdentityStore = createLinkedIdentityStore()
  const linkCodeStore = createDbLinkCodeStore()

  // Telegram-linked notify + bot-username memo (only with a bot token).
  const telegramBotTokenForNotify = env.TELEGRAM_BOT_TOKEN
  const notifyTelegramLinked = telegramBotTokenForNotify
    ? async (chatId: string, firstName: string | null) => {
        const api = createTelegramApi({ token: telegramBotTokenForNotify })
        const greeting = firstName ? ` ${firstName}` : ''
        await api.sendMessage(chatId, `You're linked${greeting}. Send me a message any time to get started.`)
      }
    : undefined
  let officialBotUsernamePromise: Promise<string | null> | undefined
  const getTelegramBotUsername = (): Promise<string | null> => {
    const token = env.TELEGRAM_BOT_TOKEN
    if (!token) return Promise.resolve(null)
    if (!officialBotUsernamePromise) {
      officialBotUsernamePromise = createTelegramApi({ token })
        .getMe()
        .then((me) => me.username || null)
        .catch((err) => {
          console.warn('[account] official bot getMe failed:', err)
          officialBotUsernamePromise = undefined
          return null
        })
    }
    return officialBotUsernamePromise
  }

  const profile = deploymentProfile()
  requireOutpostAuthPortal(profile, env.AUTH_PORTAL_URL)
  const outpostAuthConfig = validateOutpostAuthConfig(profile, env.NODE_ENV, env)
  const oidcEnrollmentStore = createWorkspaceStore()
  if (outpostAuthConfig?.oidc?.enrollment.mode === 'mapped') {
    const configuredWorkspaceIds = [...new Set(outpostAuthConfig.oidc.enrollment.rules.map((rule) => rule.workspaceId))]
    const existing = await query<{ id: string }>(
      'SELECT id FROM workspaces WHERE id = ANY($1::uuid[])',
      [configuredWorkspaceIds],
    )
    const existingIds = new Set(existing.rows.map((row) => row.id))
    const missing = configuredWorkspaceIds.filter((workspaceId) => !existingIds.has(workspaceId))
    if (missing.length > 0) {
      throw new Error(`OUTPOST_OIDC_WORKSPACE_MAPPINGS references missing workspace IDs: ${missing.join(', ')}`)
    }
  }
  const outpostBootstrapEmails = (
    (process.env.OUTPOST_AUTH_BOOTSTRAP_EMAILS ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  )
  const canSignInOutpostEmail = createEmailAdmission({
    outpost: profile === 'outpost',
    bootstrapEmails: outpostBootstrapEmails,
    findUser: findUserByEmail,
    hasPendingInvitation: async (email) => {
      const invitation = await query(
        `SELECT 1 FROM workspace_invitations
          WHERE lower(email) = $1
            AND accepted_at IS NULL
            AND expires_at > now()
          LIMIT 1`,
        [email],
      )
      return invitation.rows.length > 0
    },
  })

  const smtpUser = env.SMTP_USER ?? env.GMAIL_SMTP_USER
  const smtpPassword = env.SMTP_PASSWORD ?? env.GMAIL_SMTP_APP_PASSWORD
  const emailAuth: EmailAuth =
    (profile !== 'outpost' || outpostAuthConfig?.emailEnabled) &&
    smtpUser && smtpPassword && env.EMAIL_FROM_ADDRESS
      ? {
          magicLinkStore: createDbMagicLinkStore(),
          smtpClient: createSmtpClient({
            transport: createSmtpTransport({
              host: env.SMTP_HOST,
              port: env.SMTP_PORT,
              secure: env.SMTP_SECURE,
              user: smtpUser,
              password: smtpPassword,
            }),
            fromAddress: env.EMAIL_FROM_ADDRESS,
          }),
          appUrl: env.AUTH_PORTAL_URL ?? env.APP_URL,
          verifiedContinuation: ports.accountContinuation?.email,
          canSignInEmail: canSignInOutpostEmail,
          resolveVerifiedEmailUser: outpostAuthConfig?.localOwner
            ? async (email) => {
                const id = await adoptVerifiedLocalOwner(outpostAuthConfig.localOwner!, email)
                if (!id) return null
                const user = await findUserById(id)
                if (!user) throw new Error('outpost_owner_adoption_user_missing')
                return user
              }
            : undefined,
          allowedReturnOrigins: [env.APP_URL, env.AUTHED_APP_URL].filter((origin): origin is string => !!origin),
        }
      : undefined

  // ── Auth routes ──
  app.use(
    '/auth',
    authRoutes(
      env.JWT_SECRET,
      env.GOOGLE_CLIENT_ID ?? '',
      linkedAccountStore,
      notifyTelegramLinked,
      emailAuth,
      desktopAuthStore,
      outpostAuthConfig?.oidcEnabled && outpostAuthConfig.oidc
        ? {
            config: {
              issuer: outpostAuthConfig.oidc.issuerUrl,
              bridgeSecret: outpostAuthConfig.oidc.bridgeSecret,
              subjectIdentityEnabled: outpostAuthConfig.oidc.subjectIdentityEnabled,
              enrollment: outpostAuthConfig.oidc.enrollment,
            },
            canSignInEmail: canSignInOutpostEmail,
            findUserBySubject: async (providerId) => {
              const linked = await linkedIdentityStore.findByProvider('oidc', providerId)
              return linked
                ? findUserById(linked.userId)
                : findUserByAuthProvider('oidc', providerId)
            },
            bindUserSubject: async (userId, providerId) => {
              const result = await query<{ userId: string }>(
                `INSERT INTO linked_identities (user_id, provider, provider_id)
                 VALUES ($1, 'oidc', $2)
                 ON CONFLICT (provider, provider_id) DO UPDATE SET
                   provider_id = EXCLUDED.provider_id
                 WHERE linked_identities.user_id = EXCLUDED.user_id
                 RETURNING user_id AS "userId"`,
                [userId, providerId],
              )
              if (result.rows[0]?.userId !== userId) {
                throw new Error('OIDC subject is already bound to another user')
              }
            },
            ensureWorkspaceMembership: async (userId, workspaceIds) => {
              for (const workspaceId of workspaceIds) {
                await oidcEnrollmentStore.ensureMemberSystem(workspaceId, userId)
              }
            },
          }
        : undefined,
      undefined, // default human session store
      createDbMobileAuthStore(),
    ),
  )

  if (isLocalDevEnv()) {
    app.use('/auth', devAuthRoutes({ jwtSecret: env.JWT_SECRET }))
    console.warn('[dev-auth] LOCAL /auth/dev-login enabled — debug-only bypass.')
  }
  // The OSS single-player edition's consumer front door (not a dev bypass):
  // enabled for local launches and production-mode self-hosts, but never the
  // hosted edition or Cloud Run. Debug /auth/dev-login remains local-dev-only.
  if (isSelfHostedOssEnv()) {
    app.use(
      '/auth',
      localSessionRoutes({ jwtSecret: env.JWT_SECRET, ownerName: process.env.USEBRIAN_OWNER_NAME }),
    )
    console.log('[local-session] oss local-owner session enabled at /auth/local-session.')
  }

  return {
    profile, linkedAccountStore, emailAuth, linkedIdentityStore, channelRouteStore, resolveBackgroundRuntime,
    oauthAuthorizationStore, oauthClientStore, linkCodeStore, getTelegramBotUsername, compartmentStore,
    workspaceForAssistant, ownerForWorkspace, channelUserStore,
  } as const
}
