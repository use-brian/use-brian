import { z } from 'zod'
import { normalizeShopDomain, packShopifyTokens, shopifyGraphql, verifyShopifyOAuthQueryHmac, exchangeShopifyAuthorizationCode } from '../shopify/client.js'
import { ConnectorSetupError } from './setup-service.js'
import type { SetupProviderAdapter } from './transactional-setup.js'

/** Certified only for verifying setup identity, NOT provider isolation or a
 * Simple catalog exception. Every claimed permission comes from Shopify. */
export function connectorSetupProviders(): ReadonlyMap<string, SetupProviderAdapter> {
  return new Map([['shopify', {
    async verify(proof: unknown, callback: { state: string }) {
      const parsed = z.union([
        z.object({ shopDomain: z.string().max(255), accessToken: z.string().min(1).max(8192) }).strict(),
        z.object({ kind: z.literal('oauth'), params: z.record(z.string(), z.string().max(8192)),
          clientId: z.string().min(1).max(1024), clientSecret: z.string().min(1).max(8192) }).strict(),
      ]).parse(proof)
      let p: { shopDomain: string; accessToken: string }
      let managed: Record<string, string> = {}
      if ('kind' in parsed) {
        const domain = normalizeShopDomain(parsed.params.shop ?? '')
        if (!domain || !parsed.params.code || parsed.params.state !== callback.state || !verifyShopifyOAuthQueryHmac(parsed.params, parsed.clientSecret)) {
          throw new ConnectorSetupError('connector_setup_evidence_invalid')
        }
        const tokens = await exchangeShopifyAuthorizationCode({ shopDomain: domain, code: parsed.params.code,
          clientId: parsed.clientId, clientSecret: parsed.clientSecret })
        p = { shopDomain: domain, accessToken: tokens.accessToken }
        managed = { ...tokens, appClientId: parsed.clientId, appClientSecret: parsed.clientSecret }
      } else p = parsed
      const domain = normalizeShopDomain(p.shopDomain)
      if (!domain) throw new ConnectorSetupError('connector_setup_evidence_invalid')
      const data = await shopifyGraphql<{
        shop?: { id?: string; myshopifyDomain?: string }
        currentAppInstallation?: { accessScopes?: { handle: string }[] }
      }>({ shopDomain: domain, accessToken: p.accessToken }, `query BrianSetupIdentity {
        shop { id myshopifyDomain }
        currentAppInstallation { accessScopes { handle } }
      }`)
      const root = normalizeShopDomain(data.shop?.myshopifyDomain ?? '')
      if (!data.shop?.id || !root || root !== domain || !data.currentAppInstallation?.accessScopes?.length) {
        throw new ConnectorSetupError('connector_setup_evidence_invalid')
      }
      return {
        credentials: { type: 'oauth' as const, client_id: 'kind' in parsed ? 'shopify_oauth' : 'shopify_token', client_secret: packShopifyTokens({ ...managed, shopDomain: root, accessToken: p.accessToken }) },
        account: { subject: data.shop.id, tenant: data.shop.id, roots: [root],
          permissions: data.currentAppInstallation.accessScopes.map(s => s.handle), adapter: 'shopify-admin-identity', adapterVersion: '1' },
        label: root, config: { shopDomain: root, ...('kind' in parsed ? { byoApp: true } : {}) },
      }
    },
  }]])
}
