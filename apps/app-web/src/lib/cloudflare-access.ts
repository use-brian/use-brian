import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

const ACCESS_ASSERTION_HEADER = "Cf-Access-Jwt-Assertion";
const ACCESS_CERTS_PATH = "/cdn-cgi/access/certs";
const TEAM_HOSTNAME_PATTERN = /^[a-z0-9-]+\.cloudflareaccess\.com$/;
const AUDIENCE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const EMAIL_PATTERN = /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/;

type AccessEnvironment = Readonly<Record<string, string | undefined>>;

export type CloudflareAccessOwnerConfig =
  | { mode: "disabled" }
  | { mode: "invalid" }
  | {
      mode: "enabled";
      teamDomain: string;
      audience: string;
      ownerEmails: ReadonlySet<string>;
    };

export type CloudflareOwnerAuthorization =
  | { ok: true; email: string | null }
  | {
      ok: false;
      status: 403 | 503;
      error:
        | "cloudflare_access_required"
        | "cloudflare_access_denied"
        | "cloudflare_access_config_invalid";
    };

type AuthorizationDependencies = {
  env?: AccessEnvironment;
  resolveKey?: (certsUrl: URL) => JWTVerifyGetKey;
};

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function normalizeTeamDomain(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      !TEAM_HOSTNAME_PATTERN.test(url.hostname.toLowerCase())
    ) {
      return null;
    }
    return `https://${url.hostname.toLowerCase()}`;
  } catch {
    return null;
  }
}

/**
 * The optional remote-owner gate is deliberately all-or-none. A partial or
 * malformed deployment must not silently fall back to unrestricted local
 * owner minting.
 */
export function readCloudflareAccessOwnerConfig(
  env: AccessEnvironment = process.env,
): CloudflareAccessOwnerConfig {
  const teamDomainValue = env.CF_ACCESS_TEAM_DOMAIN?.trim() ?? "";
  const audience = env.CF_ACCESS_AUD?.trim() ?? "";
  const ownerEmailValue = env.USEBRIAN_OWNER_EMAILS?.trim() ?? "";
  const configuredValues = [teamDomainValue, audience, ownerEmailValue].filter(
    Boolean,
  ).length;

  if (configuredValues === 0) return { mode: "disabled" };
  if (configuredValues !== 3) return { mode: "invalid" };

  const teamDomain = normalizeTeamDomain(teamDomainValue);
  const ownerEmails = ownerEmailValue
    .split(",")
    .map((email) => email.trim().toLowerCase());

  if (
    teamDomain === null ||
    !AUDIENCE_PATTERN.test(audience) ||
    ownerEmails.length === 0 ||
    ownerEmails.some((email) => !EMAIL_PATTERN.test(email))
  ) {
    return { mode: "invalid" };
  }

  return {
    mode: "enabled",
    teamDomain,
    audience,
    ownerEmails: new Set(ownerEmails),
  };
}

function remoteKeySet(certsUrl: URL): JWTVerifyGetKey {
  const cacheKey = certsUrl.toString();
  let keySet = remoteKeySets.get(cacheKey);
  if (!keySet) {
    keySet = createRemoteJWKSet(certsUrl);
    remoteKeySets.set(cacheKey, keySet);
  }
  return keySet;
}

/**
 * Validate Cloudflare's signed identity and bind it to the machine's owner
 * allowlist before the web route may mint the stable local-owner session.
 */
export async function authorizeCloudflareOwner(
  request: Request,
  dependencies: AuthorizationDependencies = {},
): Promise<CloudflareOwnerAuthorization> {
  const config = readCloudflareAccessOwnerConfig(
    dependencies.env ?? process.env,
  );

  if (config.mode === "disabled") {
    return { ok: true, email: null };
  }
  if (config.mode === "invalid") {
    return {
      ok: false,
      status: 503,
      error: "cloudflare_access_config_invalid",
    };
  }

  const assertion = request.headers.get(ACCESS_ASSERTION_HEADER);
  if (!assertion) {
    return {
      ok: false,
      status: 403,
      error: "cloudflare_access_required",
    };
  }

  try {
    const certsUrl = new URL(ACCESS_CERTS_PATH, `${config.teamDomain}/`);
    const keySet = dependencies.resolveKey
      ? dependencies.resolveKey(certsUrl)
      : remoteKeySet(certsUrl);
    const { payload } = await jwtVerify(assertion, keySet, {
      algorithms: ["RS256"],
      issuer: config.teamDomain,
      audience: config.audience,
    });
    const email =
      typeof payload.email === "string"
        ? payload.email.trim().toLowerCase()
        : "";

    if (!EMAIL_PATTERN.test(email) || !config.ownerEmails.has(email)) {
      return {
        ok: false,
        status: 403,
        error: "cloudflare_access_denied",
      };
    }

    return { ok: true, email };
  } catch {
    return {
      ok: false,
      status: 403,
      error: "cloudflare_access_denied",
    };
  }
}
