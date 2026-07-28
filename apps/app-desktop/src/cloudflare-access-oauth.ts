/**
 * Cloudflare Access Managed OAuth for remote OSS targets.
 *
 * This is the pure, fetch-injectable core. Electron owns the system browser,
 * loopback server, safeStorage file, and request interception in `main.ts`;
 * this module owns every protocol and trust decision:
 *
 * - RFC 9728 / RFC 8414 discovery from the `WWW-Authenticate` challenge
 * - endpoint pinning to the user-consented app or Cloudflare Access
 * - RFC 7591 dynamic client registration
 * - RFC 8252 loopback authorization with RFC 7636 PKCE
 * - RFC 8707 resource binding
 * - opaque access/refresh grant validation and persistence serde
 * - exact-origin bearer selection (the token must never reach Brian's API)
 *
 * Spec: docs/architecture/features/app-desktop.md →
 * "Cloudflare Access on a remote self-host".
 * [COMP:app-desktop/cloudflare-access-oauth]
 */

import { z } from "zod";

const httpsUrl = z.string().url().refine((value) => new URL(value).protocol === "https:");
const nonEmpty = z.string().min(1);

const protectedResourceMetadataSchema = z.object({
  resource: httpsUrl,
  authorization_servers: z.array(z.string().url()).min(1),
});

const authorizationServerMetadataSchema = z.object({
  issuer: z.string().url().optional(),
  authorization_endpoint: httpsUrl,
  token_endpoint: httpsUrl,
  registration_endpoint: httpsUrl,
});

const clientRegistrationSchema = z.object({
  client_id: nonEmpty,
  client_secret: nonEmpty.optional(),
});

const tokenResponseSchema = z.object({
  access_token: nonEmpty,
  refresh_token: nonEmpty.optional(),
  token_type: z
    .string()
    .refine((value) => value.toLowerCase() === "bearer")
    .optional(),
  expires_in: z.number().finite().positive(),
});

const storedGrantSchema = z.object({
  v: z.literal(1),
  resource: httpsUrl,
  clientId: nonEmpty,
  clientSecret: nonEmpty.optional(),
  accessToken: nonEmpty,
  refreshToken: nonEmpty,
  accessTokenExpiresAt: z.number().finite(),
  tokenEndpoint: httpsUrl,
});

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface AccessOAuthMetadata {
  readonly resource: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string;
}

export interface AccessOAuthClient {
  readonly clientId: string;
  readonly clientSecret?: string;
}

export interface CloudflareAccessGrant {
  readonly v: 1;
  readonly resource: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: number;
  readonly tokenEndpoint: string;
}

export type DesktopConfigAccessResponse =
  | { readonly kind: "none" }
  | { readonly kind: "managed-oauth"; readonly resourceMetadataUrl: string }
  | { readonly kind: "legacy-access" };

export type AccessLoopbackCallback =
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "error"; readonly error: string };

export class AccessOAuthError extends Error {
  constructor(
    readonly code:
      | "untrusted-metadata"
      | "invalid-metadata"
      | "registration-failed"
      | "token-rejected"
      | "token-failed",
    message: string,
  ) {
    super(message);
    this.name = "AccessOAuthError";
  }
}

/**
 * Extract RFC 9728's `resource_metadata` auth-param from a Bearer challenge.
 * Cloudflare may include other schemes/params, so this intentionally searches
 * the whole header instead of assuming Bearer is the only challenge.
 */
export function parseResourceMetadataChallenge(header: string | null): string | null {
  if (!header || !/\bBearer\b/i.test(header)) return null;
  const quoted = /\bresource_metadata\s*=\s*"([^"]+)"/i.exec(header);
  if (quoted?.[1]) return quoted[1];
  const token = /\bresource_metadata\s*=\s*([^,\s]+)/i.exec(header);
  return token?.[1] ?? null;
}

/**
 * Classify the non-2xx response from `/api/desktop-config`.
 *
 * Managed OAuth is the standards-based 401 challenge. Traditional Access
 * returns an interactive 302 which a native client cannot use because the
 * system-browser and Electron cookie jars are separate.
 */
export function classifyDesktopConfigAccessResponse(input: {
  readonly status: number;
  readonly wwwAuthenticate: string | null;
  readonly location: string | null;
  readonly appUrl: string;
}): DesktopConfigAccessResponse {
  if (input.status === 401) {
    const resourceMetadataUrl = parseResourceMetadataChallenge(input.wwwAuthenticate);
    if (resourceMetadataUrl) return { kind: "managed-oauth", resourceMetadataUrl };
  }
  if (input.status >= 300 && input.status < 400 && input.location) {
    try {
      const location = new URL(input.location, input.appUrl);
      if (
        location.hostname.endsWith(".cloudflareaccess.com") ||
        location.pathname.startsWith("/cdn-cgi/access/")
      ) {
        return { kind: "legacy-access" };
      }
    } catch {
      // A malformed redirect is not an Access signal; the caller keeps its
      // ordinary self-host fallback behavior.
    }
  }
  return { kind: "none" };
}

function appOrigin(appUrl: string): string {
  return new URL(appUrl).origin;
}

/** RFC 9728 metadata is trusted only when served by the chosen app origin. */
export function isTrustedResourceMetadataUrl(metadataUrl: string, appUrl: string): boolean {
  try {
    const metadata = new URL(metadataUrl);
    return metadata.protocol === "https:" && metadata.origin === appOrigin(appUrl);
  } catch {
    return false;
  }
}

/**
 * Authorization-server endpoints may live on the app itself or on the
 * installation's Cloudflare Access team domain. No other origin is accepted.
 */
export function isTrustedAccessEndpoint(endpoint: string, appUrl: string): boolean {
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === "https:" &&
      (url.origin === appOrigin(appUrl) || url.hostname.endsWith(".cloudflareaccess.com"))
    );
  } catch {
    return false;
  }
}

function authorizationServerMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  const issuerPath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  url.pathname = `/.well-known/oauth-authorization-server${issuerPath}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function validateAuthorizationMetadata(
  raw: unknown,
  resource: string,
  appUrl: string,
): AccessOAuthMetadata {
  const parsed = authorizationServerMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AccessOAuthError("invalid-metadata", "Access authorization metadata is invalid.");
  }
  const endpoints = [
    parsed.data.authorization_endpoint,
    parsed.data.token_endpoint,
    parsed.data.registration_endpoint,
  ];
  if (parsed.data.issuer) endpoints.push(parsed.data.issuer);
  if (!endpoints.every((endpoint) => isTrustedAccessEndpoint(endpoint, appUrl))) {
    throw new AccessOAuthError(
      "untrusted-metadata",
      "Access authorization metadata points outside the selected app or Cloudflare Access.",
    );
  }
  return {
    resource,
    authorizationEndpoint: parsed.data.authorization_endpoint,
    tokenEndpoint: parsed.data.token_endpoint,
    registrationEndpoint: parsed.data.registration_endpoint,
  };
}

/**
 * Discover Access endpoints. Cloudflare's app-domain well-known endpoint may
 * return the authorization metadata directly; the two-step RFC 9728 shape
 * (`resource` + `authorization_servers`) is supported as well.
 */
export async function discoverAccessOAuth(
  appUrl: string,
  resourceMetadataUrl: string,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<AccessOAuthMetadata> {
  if (!isTrustedResourceMetadataUrl(resourceMetadataUrl, appUrl)) {
    throw new AccessOAuthError(
      "untrusted-metadata",
      "Access resource metadata is not hosted by the selected app.",
    );
  }
  const resourceResponse = await fetchImpl(resourceMetadataUrl, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    redirect: "error",
  });
  if (!resourceResponse.ok) {
    throw new AccessOAuthError(
      "invalid-metadata",
      `Access resource metadata failed (HTTP ${resourceResponse.status}).`,
    );
  }
  const raw = await resourceResponse.json();

  // Cloudflare documents an app-domain well-known endpoint that returns the
  // authorization and token endpoints directly.
  if (authorizationServerMetadataSchema.safeParse(raw).success) {
    let resource = appOrigin(appUrl);
    if (raw && typeof raw === "object" && "resource" in raw) {
      const declaredResource = httpsUrl.safeParse((raw as { resource?: unknown }).resource);
      if (
        !declaredResource.success ||
        new URL(declaredResource.data).origin !== appOrigin(appUrl)
      ) {
        throw new AccessOAuthError(
          "untrusted-metadata",
          "Access metadata describes a different protected resource.",
        );
      }
      resource = declaredResource.data;
    }
    return validateAuthorizationMetadata(raw, resource, appUrl);
  }

  const protectedResource = protectedResourceMetadataSchema.safeParse(raw);
  if (!protectedResource.success) {
    throw new AccessOAuthError("invalid-metadata", "Access resource metadata is invalid.");
  }
  if (new URL(protectedResource.data.resource).origin !== appOrigin(appUrl)) {
    throw new AccessOAuthError(
      "untrusted-metadata",
      "Access metadata describes a different protected resource.",
    );
  }
  const issuer = protectedResource.data.authorization_servers[0];
  if (!isTrustedAccessEndpoint(issuer, appUrl)) {
    throw new AccessOAuthError(
      "untrusted-metadata",
      "Access metadata points to an untrusted authorization server.",
    );
  }
  const metadataResponse = await fetchImpl(authorizationServerMetadataUrl(issuer), {
    headers: { Accept: "application/json" },
    cache: "no-store",
    redirect: "error",
  });
  if (!metadataResponse.ok) {
    throw new AccessOAuthError(
      "invalid-metadata",
      `Access authorization metadata failed (HTTP ${metadataResponse.status}).`,
    );
  }
  return validateAuthorizationMetadata(
    await metadataResponse.json(),
    protectedResource.data.resource,
    appUrl,
  );
}

/** Dynamically register this ephemeral loopback client (RFC 7591). */
export async function registerAccessClient(
  metadata: AccessOAuthMetadata,
  redirectUri: string,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<AccessOAuthClient> {
  const response = await fetchImpl(metadata.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Use Brian Desktop",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
    redirect: "error",
  });
  if (!response.ok) {
    throw new AccessOAuthError(
      "registration-failed",
      `Access client registration failed (HTTP ${response.status}).`,
    );
  }
  const parsed = clientRegistrationSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new AccessOAuthError("registration-failed", "Access client registration was invalid.");
  }
  return {
    clientId: parsed.data.client_id,
    ...(parsed.data.client_secret ? { clientSecret: parsed.data.client_secret } : {}),
  };
}

/** Build the browser authorization request (PKCE + state + RFC 8707 resource). */
export function buildAccessAuthorizationUrl(input: {
  readonly metadata: AccessOAuthMetadata;
  readonly client: AccessOAuthClient;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly state: string;
}): string {
  const url = new URL(input.metadata.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.client.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  url.searchParams.set("resource", input.metadata.resource);
  return url.toString();
}

export function buildAccessLoopbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}/cloudflare-access/callback`;
}

/** Parse the loopback callback and bind it to the authorization request. */
export function parseAccessLoopbackCallback(
  requestTarget: string,
  expectedState: string,
): AccessLoopbackCallback | null {
  let url: URL;
  try {
    url = new URL(requestTarget, "http://127.0.0.1");
  } catch {
    return null;
  }
  if (url.pathname !== "/cloudflare-access/callback") return null;
  if (url.searchParams.get("state") !== expectedState) return null;
  const error = url.searchParams.get("error");
  if (error) return { kind: "error", error };
  const code = url.searchParams.get("code");
  return code ? { kind: "code", code } : { kind: "error", error: "no_code" };
}

function tokenBody(
  fields: Record<string, string | undefined>,
  client: AccessOAuthClient,
): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) body.set(key, value);
  }
  body.set("client_id", client.clientId);
  if (client.clientSecret) body.set("client_secret", client.clientSecret);
  return body;
}

/** Exchange the loopback authorization code for the initial opaque grant. */
export async function exchangeAccessCode(
  input: {
    readonly metadata: AccessOAuthMetadata;
    readonly client: AccessOAuthClient;
    readonly redirectUri: string;
    readonly code: string;
    readonly verifier: string;
    readonly nowMs: number;
  },
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<CloudflareAccessGrant> {
  const response = await fetchImpl(input.metadata.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: tokenBody(
      {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.verifier,
        resource: input.metadata.resource,
      },
      input.client,
    ).toString(),
    redirect: "error",
  });
  if (!response.ok) {
    throw new AccessOAuthError(
      "token-rejected",
      `Access authorization was rejected (HTTP ${response.status}).`,
    );
  }
  const parsed = tokenResponseSchema.safeParse(await response.json());
  if (!parsed.success || !parsed.data.refresh_token) {
    throw new AccessOAuthError("token-failed", "Access returned an invalid token response.");
  }
  return {
    v: 1,
    resource: input.metadata.resource,
    clientId: input.client.clientId,
    ...(input.client.clientSecret ? { clientSecret: input.client.clientSecret } : {}),
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    accessTokenExpiresAt: input.nowMs + parsed.data.expires_in * 1000,
    tokenEndpoint: input.metadata.tokenEndpoint,
  };
}

/**
 * Refresh an opaque Access grant. `null` means the grant was definitively
 * rejected and must be removed; transient/server failures throw so callers can
 * retain it and retry later.
 */
export async function refreshAccessGrant(
  grant: CloudflareAccessGrant,
  nowMs: number,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<CloudflareAccessGrant | null> {
  const response = await fetchImpl(grant.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: tokenBody(
      {
        grant_type: "refresh_token",
        refresh_token: grant.refreshToken,
        resource: grant.resource,
      },
      { clientId: grant.clientId, clientSecret: grant.clientSecret },
    ).toString(),
    redirect: "error",
  });
  if (response.status === 400 || response.status === 401 || response.status === 403) return null;
  if (!response.ok) {
    throw new AccessOAuthError(
      "token-failed",
      `Access token refresh failed (HTTP ${response.status}).`,
    );
  }
  const parsed = tokenResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new AccessOAuthError("token-failed", "Access returned an invalid refresh response.");
  }
  return {
    ...grant,
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? grant.refreshToken,
    accessTokenExpiresAt: nowMs + parsed.data.expires_in * 1000,
  };
}

export function serializeAccessGrant(grant: CloudflareAccessGrant): string {
  return JSON.stringify(storedGrantSchema.parse(grant));
}

export function parseAccessGrant(raw: string): CloudflareAccessGrant | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = storedGrantSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function isAccessGrantExpiring(
  grant: CloudflareAccessGrant,
  nowMs: number,
  skewMs = 60_000,
): boolean {
  return grant.accessTokenExpiresAt - nowMs <= skewMs;
}

export function accessGrantMatchesApp(
  grant: CloudflareAccessGrant,
  appUrl: string,
): boolean {
  try {
    return new URL(grant.resource).origin === appOrigin(appUrl);
  } catch {
    return false;
  }
}

/**
 * Return the Access Authorization value only for the grant's exact origin.
 * This small helper is the credential-leak boundary used by both config probes
 * and Electron's `webRequest` hook.
 */
export function accessAuthorizationForUrl(
  grant: CloudflareAccessGrant | null,
  requestUrl: string,
): string | null {
  if (!grant) return null;
  try {
    if (new URL(requestUrl).origin !== new URL(grant.resource).origin) return null;
    return `Bearer ${grant.accessToken}`;
  } catch {
    return null;
  }
}
