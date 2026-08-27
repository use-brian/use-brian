import { createHash } from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import type { PortalConfig } from "./config";

const ID_TOKEN_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"];

export type OidcMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
};

export type VerifiedOidcIdentity = {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: true;
  name?: string;
  avatarUrl?: string;
};

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined;
}

function endpoint(raw: unknown, name: string, production: boolean, allowedOrigins: string[]): string {
  if (typeof raw !== "string") throw new Error(`${name} missing`);
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (production && url.protocol !== "https:") ||
    !allowedOrigins.includes(url.origin) || url.username || url.password || url.hash
  ) {
    throw new Error(`${name} invalid`);
  }
  return url.toString();
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("OIDC response too large");
  if (!response.body) throw new Error("OIDC response missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("OIDC response too large");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
}

async function providerFetch(
  fetchFn: typeof fetch,
  url: string | URL,
  allowedOrigins: string[],
  init: RequestInit = {},
): Promise<Response> {
  const target = new URL(url);
  if (!allowedOrigins.includes(target.origin)) throw new Error("OIDC endpoint origin mismatch");
  return fetchFn(target, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
}

export async function discoverOidc(config: PortalConfig, fetchFn: typeof fetch = fetch): Promise<OidcMetadata> {
  if (!config.oidc) throw new Error("OIDC disabled");
  const discoveryUrl = new URL(`${config.oidc.issuerUrl.replace(/\/$/, "")}/.well-known/openid-configuration`);
  const issuerOrigin = new URL(config.oidc.issuerUrl).origin;
  const response = await providerFetch(fetchFn, discoveryUrl, [issuerOrigin], { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error("OIDC discovery failed");
  const raw = await readJson(response, 256 * 1024) as Partial<OidcMetadata>;
  if (raw.issuer !== config.oidc.issuerUrl) throw new Error("OIDC issuer mismatch");
  const production = process.env.NODE_ENV === "production";
  return {
    issuer: raw.issuer,
    authorization_endpoint: endpoint(raw.authorization_endpoint, "authorization_endpoint", production, config.oidc.allowedEndpointOrigins),
    token_endpoint: endpoint(raw.token_endpoint, "token_endpoint", production, config.oidc.allowedEndpointOrigins),
    jwks_uri: endpoint(raw.jwks_uri, "jwks_uri", production, config.oidc.allowedEndpointOrigins),
    ...(Array.isArray(raw.token_endpoint_auth_methods_supported)
      ? { token_endpoint_auth_methods_supported: raw.token_endpoint_auth_methods_supported.filter((item): item is string => typeof item === "string") }
      : {}),
  };
}

export function oidcCallbackUrl(config: PortalConfig): string {
  return new URL("/api/auth/oidc/callback", config.portalOrigin).toString();
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function authorizationUrl(
  metadata: OidcMetadata,
  config: PortalConfig,
  input: { state: string; nonce: string; challenge: string },
): URL {
  if (!config.oidc) throw new Error("OIDC disabled");
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("client_id", config.oidc.clientId);
  url.searchParams.set("redirect_uri", oidcCallbackUrl(config));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

export async function exchangeOidcCode(
  metadata: OidcMetadata,
  config: PortalConfig,
  code: string,
  verifier: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  if (!config.oidc) throw new Error("OIDC disabled");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: oidcCallbackUrl(config),
    code_verifier: verifier,
  });
  const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" };
  const methods = metadata.token_endpoint_auth_methods_supported;
  if (!methods || methods.includes("client_secret_basic")) {
    const encode = (value: string) => new URLSearchParams({ value }).toString().slice("value=".length);
    headers.Authorization = `Basic ${Buffer.from(`${encode(config.oidc.clientId)}:${encode(config.oidc.clientSecret)}`).toString("base64")}`;
  } else if (methods.includes("client_secret_post")) {
    body.set("client_id", config.oidc.clientId);
    body.set("client_secret", config.oidc.clientSecret);
  } else {
    throw new Error("Unsupported OIDC client authentication method");
  }
  const response = await providerFetch(fetchFn, metadata.token_endpoint, config.oidc.allowedEndpointOrigins, { method: "POST", headers, body });
  if (!response.ok) throw new Error("OIDC token exchange failed");
  const token = await readJson(response, 256 * 1024) as { id_token?: unknown };
  if (typeof token.id_token !== "string" || token.id_token.length > 16_384) throw new Error("OIDC ID token missing");
  return token.id_token;
}

export async function verifyOidcIdentity(
  idToken: string,
  metadata: OidcMetadata,
  config: PortalConfig,
  nonce: string,
  fetchFn: typeof fetch = fetch,
): Promise<VerifiedOidcIdentity> {
  if (!config.oidc) throw new Error("OIDC disabled");
  const jwksResponse = await providerFetch(fetchFn, metadata.jwks_uri, config.oidc.allowedEndpointOrigins, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!jwksResponse.ok) throw new Error("OIDC JWKS fetch failed");
  const jwks = createLocalJWKSet(await readJson(jwksResponse, 1024 * 1024) as JSONWebKeySet);
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: config.oidc.issuerUrl,
    audience: config.oidc.clientId,
    algorithms: ID_TOKEN_ALGORITHMS,
  });
  validateAuthorizedParty(payload, config.oidc.clientId);
  if (payload.nonce !== nonce) throw new Error("OIDC nonce mismatch");
  const subject = boundedString(payload.sub, 512);
  const email = boundedString(payload.email, 320)?.toLowerCase();
  if (!subject) throw new Error("OIDC subject required");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("OIDC email required");
  if (config.oidc.emailVerification === "claim" && payload.email_verified !== true) throw new Error("OIDC verified email required");
  const name = boundedString(payload.name, 200);
  const avatarUrl = boundedString(payload.picture, 2048);
  return {
    issuer: config.oidc.issuerUrl,
    subject,
    email,
    emailVerified: true,
    ...(name ? { name } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

function validateAuthorizedParty(payload: JWTPayload, clientId: string): void {
  const audience = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if ((audience.length > 1 || payload.azp !== undefined) && payload.azp !== clientId) {
    throw new Error("OIDC authorized party mismatch");
  }
}
