/**
 * Provider module registry (M3 WP2): one `ProviderModule` per connector
 * family. Pass it to `createActivation({ providers: PROVIDER_MODULES, ... })`.
 *
 * See docs/architecture/integrations/mcp.md → "Provider activation".
 */
import type { ProviderFamily, ProviderModule } from './types.js'
import { agentmailProvider } from './agentmail.js'
import { cliProvider } from './cli.js'
import { fathomProvider } from './fathom.js'
import { githubProvider } from './github.js'
import { googleMapsProvider } from './google-maps.js'
import { googleProvider } from './google.js'
import { gscProvider } from './gsc.js'
import { knowledgeProvider } from './knowledge.js'
import { mailboxProvider } from './mailbox.js'
import { msgraphProvider } from './msgraph.js'
import { notionProvider } from './notion.js'
import { remoteMcpProvider } from './remote-mcp.js'
import { shopifyProvider } from './shopify.js'
import { wordpressProvider } from './wordpress.js'

export const PROVIDER_MODULES: Readonly<Record<ProviderFamily, ProviderModule<never>>> = {
  google: googleProvider,
  github: githubProvider,
  notion: notionProvider,
  fathom: fathomProvider,
  shopify: shopifyProvider,
  wordpress: wordpressProvider,
  gsc: gscProvider,
  msgraph: msgraphProvider,
  mailbox: mailboxProvider,
  agentmail: agentmailProvider,
  'remote-mcp': remoteMcpProvider,
  cli: cliProvider,
  knowledge: knowledgeProvider,
  'google-maps': googleMapsProvider,
}

export * from './types.js'
