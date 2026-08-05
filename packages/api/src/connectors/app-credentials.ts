/**
 * `app-credentials.ts` — resolve a built-in connector's OAuth *app* pair.
 *
 * One question, one answer, three sources, in this order:
 *
 *   1. the workspace's own registration (`connector_app_credentials`, set in
 *      Studio -> Connectors by an owner/admin)
 *   2. `~/.usebrian/connectors.config.json`
 *   3. `<PROVIDER>_CLIENT_ID` / `_CLIENT_SECRET` env
 *
 * Order matters and is not arbitrary. A workspace that went to the trouble of
 * registering its own app means it: silently preferring the deployment's app
 * would consent its members into the wrong tenant. Everything below the
 * workspace layer is what `getConnectorConfig` already returned, unchanged, so
 * a self-host with env set behaves exactly as it did before this file existed.
 *
 * `source` travels with the result because the UI must say which app a connect
 * will actually use. "Configured" is not a boolean the frontend can compute:
 * it depends on deployment config the browser cannot see.
 *
 * This module is the ONLY place that merges the three. A call site that reads
 * `getConnectorConfig` directly for a configurable provider silently ignores
 * the workspace's registration - which is invisible until a customer's connect
 * lands in the wrong tenant.
 *
 * See docs/architecture/integrations/msgraph.md → "Auth".
 */

import { getConnectorConfig, type ConnectorProvider } from '../connector-config.js'
import type { ConnectorAppCredentialStore } from '../db/connector-app-credential-store.js'

export type ConnectorAppConfigSource = 'workspace' | 'deployment'

export type ResolvedConnectorAppConfig = {
  clientId: string
  clientSecret: string
  /** Provider-specific authority hint (msgraph: the Entra directory id). */
  tenantId?: string
  source: ConnectorAppConfigSource
}

export type ResolveConnectorAppConfigParams = {
  provider: ConnectorProvider
  /** Absent on paths with no workspace in hand — resolution then starts at step 2. */
  workspaceId?: string | null
  store?: ConnectorAppCredentialStore | null
}

/**
 * Resolve the pair an OAuth exchange should use. Returns undefined when no
 * source has one, which is the connector-less boot the open product ships in.
 */
export async function resolveConnectorAppConfig(
  params: ResolveConnectorAppConfigParams,
): Promise<ResolvedConnectorAppConfig | undefined> {
  const { provider, workspaceId, store } = params

  if (workspaceId && store) {
    try {
      const owned = await store.getSystem(workspaceId, provider)
      if (owned) return { ...owned, source: 'workspace' }
    } catch (err) {
      // A decrypt failure (rotated CHANNEL_CREDENTIAL_KEY) must not silently
      // fall through to the deployment app: that would consent the user into a
      // different tenant than the one their admin registered, and the only
      // symptom would be a connector that reads the wrong company's Teams.
      // Fail the resolve instead — reconnecting after re-entering the secret
      // is recoverable; a wrong-tenant grant is not.
      throw new Error(
        `Could not read the workspace's ${provider} app credentials: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const deployment = getConnectorConfig(provider)
  if (deployment) return { ...deployment, source: 'deployment' }
  return undefined
}

/**
 * What the Studio panel renders. Never carries a secret: the summary answers
 * "is this connector usable, and whose app will it use", which is exactly the
 * information the connect button needs and nothing more.
 */
export type ConnectorAppConfigStatus = {
  configured: boolean
  source: ConnectorAppConfigSource | null
  /** Public half of the pair — safe to hand the browser, it rides in the authorize URL. */
  clientId: string | null
  tenantId: string | null
  /** True when a workspace row exists, i.e. the panel should offer "remove". */
  workspaceOwned: boolean
  updatedAt: string | null
}

export async function getConnectorAppConfigStatus(params: {
  provider: ConnectorProvider
  actingUserId: string
  workspaceId?: string | null
  store?: ConnectorAppCredentialStore | null
}): Promise<ConnectorAppConfigStatus> {
  const { provider, actingUserId, workspaceId, store } = params

  if (workspaceId && store) {
    const owned = await store.get(actingUserId, workspaceId, provider)
    if (owned) {
      return {
        configured: true,
        source: 'workspace',
        clientId: owned.clientId,
        tenantId: owned.tenantId,
        workspaceOwned: true,
        updatedAt: owned.updatedAt.toISOString(),
      }
    }
  }

  const deployment = getConnectorConfig(provider)
  return {
    configured: !!deployment,
    source: deployment ? 'deployment' : null,
    clientId: deployment?.clientId ?? null,
    tenantId: null,
    workspaceOwned: false,
    updatedAt: null,
  }
}
