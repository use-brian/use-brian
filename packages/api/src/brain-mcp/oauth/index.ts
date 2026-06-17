/**
 * Brain MCP OAuth 2.1 module — public exports.
 *
 * The OAuth front-door to the brain MCP server. Lets claude.ai / Claude
 * Desktop / ChatGPT custom-connector flows reach the same `BrainAuth`
 * principal the existing `sk_brain_*` API keys produce.
 *
 * See routes.ts for the protocol endpoints, metadata.ts for the well-known
 * discovery endpoints. Tokens (oac_/oat_/ort_) are scrypt-hashed via the
 * shared api-key-store helpers; the auth shim in `../auth.ts` accepts both
 * formats.
 *
 * Component tag: [COMP:api/brain-oauth].
 * Spec: docs/architecture/features/programmatic-access.md → "OAuth 2.1 mode".
 */

export { oauthMetadataRoutes } from './metadata.js'
export { oauthRoutes } from './routes.js'
export type { OAuthRoutesOptions } from './routes.js'
export {
  signConsentRequest,
  verifyConsentRequest,
  CONSENT_REQUEST_TTL_SECONDS,
  type OAuthConsentRequest,
} from './codes.js'
