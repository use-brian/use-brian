import { parse as parseDomain } from "tldts";

export type PortalConfig = {
  internalApiUrl: string;
  portalOrigin: string;
  appOrigin: string;
  cookieDomain?: string;
  trustProxyHeaders: boolean;
  emailEnabled: boolean;
  oidcEnabled: boolean;
  oidc?: {
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    providerName: string;
    bridgeSecret: string;
    allowedEndpointOrigins: string[];
    emailVerification: "claim" | "issuer";
    subjectIdentityEnabled: boolean;
    enrollment: {
      mode: "invite_only" | "mapped";
      groupClaim?: string;
      additionalScopes: string[];
    };
  };
};

function strictBoolean(raw: string | undefined, name: string, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be one of true, false, 1, or 0`);
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when OUTPOST_AUTH_OIDC_ENABLED=true`);
  return value;
}

function originOf(raw: string | undefined, name: string, fallback?: string): string {
  const value = raw?.trim() || fallback;
  if (!value) throw new Error(`${name} is required`);
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  return url.origin;
}

export function resolvePortalConfig(
  env: Record<string, string | undefined>,
  production = env.NODE_ENV === "production",
): PortalConfig {
  const internalApiUrl = originOf(env.INTERNAL_API_URL, "INTERNAL_API_URL", "http://127.0.0.1:4000");
  const portalOrigin = originOf(env.AUTH_PORTAL_URL, "AUTH_PORTAL_URL", "http://localhost:3005");
  const appOrigin = originOf(env.AUTHED_APP_URL, "AUTHED_APP_URL", "http://localhost:3003");
  const rawDomain = env.COOKIE_DOMAIN?.trim();
  const emailEnabled = strictBoolean(env.OUTPOST_AUTH_EMAIL_ENABLED, "OUTPOST_AUTH_EMAIL_ENABLED", true);
  const oidcEnabled = strictBoolean(env.OUTPOST_AUTH_OIDC_ENABLED, "OUTPOST_AUTH_OIDC_ENABLED", false);

  if (!emailEnabled && !oidcEnabled) throw new Error("Outpost requires at least one enabled authentication provider");
  if (production && !rawDomain) throw new Error("COOKIE_DOMAIN is required in production");
  if (production && (new URL(portalOrigin).protocol !== "https:" || new URL(appOrigin).protocol !== "https:")) {
    throw new Error("Outpost public origins must use https in production");
  }
  if (rawDomain) {
    const suffix = rawDomain.slice(1).toLowerCase();
    const labels = suffix.split(".");
    const parsed = parseDomain(suffix);
    const validLabels = labels.every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label));
    if (!rawDomain.startsWith(".") || !validLabels || !parsed.domain || !parsed.publicSuffix || suffix === parsed.domain || suffix === parsed.publicSuffix) {
      throw new Error("COOKIE_DOMAIN must be a dot-prefixed DNS suffix");
    }
    for (const origin of [portalOrigin, appOrigin]) {
      const host = new URL(origin).hostname.toLowerCase();
      if (host !== suffix && !host.endsWith(`.${suffix}`)) {
        throw new Error("AUTH_PORTAL_URL and AUTHED_APP_URL must be inside COOKIE_DOMAIN");
      }
    }
  }

  let oidc: PortalConfig["oidc"];
  if (oidcEnabled) {
    const issuerUrl = required(env, "OUTPOST_OIDC_ISSUER_URL");
    let issuer: URL;
    try {
      issuer = new URL(issuerUrl);
    } catch {
      throw new Error("OUTPOST_OIDC_ISSUER_URL must be an absolute URL");
    }
    if (!["http:", "https:"].includes(issuer.protocol) || issuer.username || issuer.password || issuer.search || issuer.hash) {
      throw new Error("OUTPOST_OIDC_ISSUER_URL must be an HTTP(S) URL without credentials, query, or fragment");
    }
    if (production && issuer.protocol !== "https:") throw new Error("OUTPOST_OIDC_ISSUER_URL must use HTTPS in production");
    const bridgeSecret = required(env, "OUTPOST_AUTH_BRIDGE_SECRET");
    if (bridgeSecret.length < 32) throw new Error("OUTPOST_AUTH_BRIDGE_SECRET must be at least 32 characters");
    const allowedEndpointOrigins = [issuer.origin];
    for (const raw of (env.OUTPOST_OIDC_ALLOWED_ENDPOINT_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
      const allowed = new URL(raw);
      if (allowed.toString() !== `${allowed.origin}/` || (production && allowed.protocol !== "https:")) {
        throw new Error("OUTPOST_OIDC_ALLOWED_ENDPOINT_ORIGINS must contain comma-separated HTTPS origins");
      }
      if (!allowedEndpointOrigins.includes(allowed.origin)) allowedEndpointOrigins.push(allowed.origin);
    }
    const emailVerification = env.OUTPOST_OIDC_EMAIL_VERIFICATION?.trim() || "claim";
    if (emailVerification !== "claim" && emailVerification !== "issuer") {
      throw new Error("OUTPOST_OIDC_EMAIL_VERIFICATION must be claim or issuer");
    }
    const subjectIdentityEnabled = strictBoolean(
      env.OUTPOST_OIDC_SUBJECT_IDENTITY_ENABLED,
      "OUTPOST_OIDC_SUBJECT_IDENTITY_ENABLED",
      false,
    );
    const enrollment = resolveOidcEnrollment(env);
    oidc = {
      issuerUrl,
      clientId: required(env, "OUTPOST_OIDC_CLIENT_ID"),
      clientSecret: required(env, "OUTPOST_OIDC_CLIENT_SECRET"),
      providerName: required(env, "OUTPOST_OIDC_PROVIDER_NAME"),
      bridgeSecret,
      allowedEndpointOrigins,
      emailVerification,
      subjectIdentityEnabled,
      enrollment,
    };
  }

  return {
    internalApiUrl,
    portalOrigin,
    appOrigin,
    trustProxyHeaders: env.TRUST_PROXY_HEADERS === "true",
    emailEnabled,
    oidcEnabled,
    ...(rawDomain ? { cookieDomain: rawDomain } : {}),
    ...(oidc ? { oidc } : {}),
  };
}

function resolveOidcEnrollment(env: Record<string, string | undefined>): NonNullable<PortalConfig["oidc"]>["enrollment"] {
  const mode = env.OUTPOST_OIDC_ENROLLMENT_MODE?.trim() || "invite_only";
  if (mode !== "invite_only" && mode !== "mapped") {
    throw new Error("OUTPOST_OIDC_ENROLLMENT_MODE must be invite_only or mapped");
  }
  if (mode === "invite_only") return { mode, additionalScopes: [] };
  const raw = required(env, "OUTPOST_OIDC_WORKSPACE_MAPPINGS");
  if (Buffer.byteLength(raw, "utf8") > 32 * 1024) throw new Error("OUTPOST_OIDC_WORKSPACE_MAPPINGS is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OUTPOST_OIDC_WORKSPACE_MAPPINGS must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OUTPOST_OIDC_WORKSPACE_MAPPINGS has an invalid shape");
  }
  const value = parsed as Record<string, unknown>;
  const allowedKeys = new Set(["version", "groupClaim", "additionalScopes", "rules"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key)) || value.version !== 1 || !Array.isArray(value.rules) || value.rules.length < 1 || value.rules.length > 128) {
    throw new Error("OUTPOST_OIDC_WORKSPACE_MAPPINGS has an invalid shape");
  }
  const hasGroupRule = value.rules.some((rule) => !!rule && typeof rule === "object" && !Array.isArray(rule) && "group" in rule);
  const groupClaim = value.groupClaim;
  if (groupClaim !== undefined && (typeof groupClaim !== "string" || groupClaim.length < 1 || groupClaim.length > 200 || groupClaim.trim() !== groupClaim || /[\x00-\x1f\x7f]/.test(groupClaim))) {
    throw new Error("OUTPOST_OIDC_WORKSPACE_MAPPINGS groupClaim is invalid");
  }
  if (hasGroupRule && typeof groupClaim !== "string") {
    throw new Error("OUTPOST_OIDC_WORKSPACE_MAPPINGS groupClaim is required for group rules");
  }
  const rawScopes = value.additionalScopes ?? [];
  if (!Array.isArray(rawScopes) || rawScopes.length > 16 || rawScopes.some((scope) => typeof scope !== "string" || !/^[\x21\x23-\x5b\x5d-\x7e]{1,100}$/.test(scope))) {
    throw new Error("OUTPOST_OIDC_WORKSPACE_MAPPINGS additionalScopes are invalid");
  }
  const additionalScopes = [...new Set(rawScopes as string[])].filter((scope) => !["openid", "email", "profile"].includes(scope));
  return {
    mode,
    ...(typeof groupClaim === "string" ? { groupClaim } : {}),
    additionalScopes,
  };
}

export function portalConfig(): PortalConfig {
  return resolvePortalConfig(process.env);
}
