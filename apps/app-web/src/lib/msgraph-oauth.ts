/**
 * Microsoft Graph (Teams) OAuth - the browser half: authority resolution and
 * the authorize-URL builder.
 *
 * The **exchange half deliberately does not live here**. It runs in the API
 * (`POST /api/connectors/msgraph/oauth-callback`), for the same reason the
 * Shopify BYO flow put it there: the client secret may belong to a customer's
 * own Entra app, stored encrypted in their workspace, and it must never be
 * handed to a Next.js route to post from. app-web keeps only the job that
 * needs its cookie - the state-nonce CSRF gate - and forwards the code.
 *
 * Auth model: the app pair is resolved server-side per workspace
 * (`connector_app_credentials`, then the config file, then env). The browser
 * receives only the **client id and tenant**, from
 * `GET /api/connectors/msgraph/app-credentials` - both are public, they ride
 * in the authorize URL. `NEXT_PUBLIC_MSGRAPH_CLIENT_ID` is gone: a build-time
 * env var cannot express "this workspace uses its own registration".
 *
 * See docs/architecture/integrations/msgraph.md → "Auth".
 */

import { msGraphScopes } from "@use-brian/shared/builtin-connectors";

export { msGraphScopes };

/**
 * Default tenant segment of the Entra endpoints. `organizations` restricts the
 * account picker to work/school accounts, the only population this connector
 * can serve: every Teams delegated permission publishes "Delegated (personal
 * Microsoft account): Not supported", so under `common` a user could pick a
 * personal MSA, complete consent *successfully*, and then have all nine tools
 * fail at runtime with nothing actionable to tell them. Microsoft is explicit
 * about the consent half too - "Do not use 'common', as personal accounts
 * cannot provide admin consent except in the context of a tenant" - and
 * `ChannelMessage.Read.All` requires admin consent unconditionally.
 *
 * A workspace that registered a SINGLE-tenant app overrides this with its own
 * directory id, which is strictly narrower. The override travels with the
 * credentials from the API, so the authorize call and the token call cannot
 * disagree about the authority - the token call reads the same stored row.
 * Must stay in step with `DEFAULT_TENANT` in `packages/api/src/msgraph/token.ts`.
 */
export const MSGRAPH_DEFAULT_TENANT = "organizations";

export function msGraphAuthorizeUrl(tenant?: string | null): string {
  const segment = tenant?.trim() || MSGRAPH_DEFAULT_TENANT;
  return `https://login.microsoftonline.com/${encodeURIComponent(segment)}/oauth2/v2.0/authorize`;
}

/**
 * Build the Entra authorize URL. `response_mode=query` keeps the code in the
 * query string, which is what the callback route reads.
 */
export function buildMsGraphAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  /** Built by `buildConnectorState` - carries the connector, workspace, and CSRF nonce. */
  state: string;
  /** The workspace's directory id when it registered a single-tenant app. */
  tenant?: string | null;
  /** Defaults to `msGraphScopes()`; injectable for tests. */
  scopes?: string[];
}): string {
  const sp = new URLSearchParams({
    client_id: input.clientId,
    response_type: "code",
    redirect_uri: input.redirectUri,
    response_mode: "query",
    scope: (input.scopes ?? msGraphScopes()).join(" "),
    state: input.state,
  });
  return `${msGraphAuthorizeUrl(input.tenant)}?${sp}`;
}
