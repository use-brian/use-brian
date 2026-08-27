import { domainToASCII } from 'node:url'

export type OutpostAuthConfigInput = {
  OUTPOST_AUTH_EMAIL_ENABLED?: boolean
  OUTPOST_AUTH_OIDC_ENABLED?: boolean
  OUTPOST_OIDC_SUBJECT_IDENTITY_ENABLED?: boolean
  OUTPOST_OIDC_ENROLLMENT_MODE?: string
  OUTPOST_OIDC_WORKSPACE_MAPPINGS?: string
  OUTPOST_OIDC_ISSUER_URL?: string
  OUTPOST_OIDC_CLIENT_ID?: string
  OUTPOST_OIDC_CLIENT_SECRET?: string
  OUTPOST_OIDC_PROVIDER_NAME?: string
  OUTPOST_AUTH_BRIDGE_SECRET?: string
  GMAIL_SMTP_USER?: string
  GMAIL_SMTP_APP_PASSWORD?: string
  EMAIL_FROM_ADDRESS?: string
}

export type OutpostAuthConfig = {
  emailEnabled: boolean
  oidcEnabled: boolean
  oidc?: {
    issuerUrl: string
    clientId: string
    clientSecret: string
    providerName: string
    bridgeSecret: string
    subjectIdentityEnabled: boolean
    enrollment: OidcEnrollmentConfig
  }
}

export type OidcWorkspaceMappingRule = {
  workspaceId: string
  emailDomain?: string
  group?: string
}

export type OidcEnrollmentConfig =
  | { mode: 'invite_only' }
  | {
      mode: 'mapped'
      groupClaim?: string
      additionalScopes: string[]
      rules: OidcWorkspaceMappingRule[]
    }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SCOPE_RE = /^[\x21\x23-\x5b\x5d-\x7e]{1,100}$/

export function parseStrictBoolean(
  raw: string | undefined,
  name: string,
  defaultValue: boolean,
): boolean {
  if (raw === undefined) return defaultValue
  const value = raw.trim().toLowerCase()
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new Error(`${name} must be one of true, false, 1, or 0`)
}

export function validateOutpostAuthConfig(
  profile: string,
  nodeEnv: string,
  input: OutpostAuthConfigInput,
): OutpostAuthConfig | undefined {
  if (profile !== 'outpost') return undefined

  const emailEnabled = input.OUTPOST_AUTH_EMAIL_ENABLED ?? true
  const oidcEnabled = input.OUTPOST_AUTH_OIDC_ENABLED ?? false
  if (!emailEnabled && !oidcEnabled) {
    throw new Error('Outpost requires at least one enabled authentication provider')
  }

  if (emailEnabled) {
    requireValues(input, [
      'GMAIL_SMTP_USER',
      'GMAIL_SMTP_APP_PASSWORD',
      'EMAIL_FROM_ADDRESS',
    ], 'Outpost email authentication')
  }

  if (!oidcEnabled) return { emailEnabled, oidcEnabled }

  requireValues(input, [
    'OUTPOST_OIDC_ISSUER_URL',
    'OUTPOST_OIDC_CLIENT_ID',
    'OUTPOST_OIDC_CLIENT_SECRET',
    'OUTPOST_OIDC_PROVIDER_NAME',
    'OUTPOST_AUTH_BRIDGE_SECRET',
  ], 'Outpost OIDC authentication')

  const issuerUrl = input.OUTPOST_OIDC_ISSUER_URL!.trim()
  let issuer: URL
  try {
    issuer = new URL(issuerUrl)
  } catch {
    throw new Error('OUTPOST_OIDC_ISSUER_URL must be an absolute URL')
  }
  if (!['http:', 'https:'].includes(issuer.protocol) || issuer.username || issuer.password || issuer.search || issuer.hash) {
    throw new Error('OUTPOST_OIDC_ISSUER_URL must be an HTTP(S) URL without credentials, query, or fragment')
  }
  if (nodeEnv === 'production' && issuer.protocol !== 'https:') {
    throw new Error('OUTPOST_OIDC_ISSUER_URL must use HTTPS in production')
  }

  const bridgeSecret = input.OUTPOST_AUTH_BRIDGE_SECRET!.trim()
  if (bridgeSecret.length < 32) {
    throw new Error('OUTPOST_AUTH_BRIDGE_SECRET must be at least 32 characters')
  }
  const enrollment = parseOidcEnrollmentConfig(
    input.OUTPOST_OIDC_ENROLLMENT_MODE,
    input.OUTPOST_OIDC_WORKSPACE_MAPPINGS,
  )

  return {
    emailEnabled,
    oidcEnabled,
    oidc: {
      issuerUrl,
      clientId: input.OUTPOST_OIDC_CLIENT_ID!.trim(),
      clientSecret: input.OUTPOST_OIDC_CLIENT_SECRET!.trim(),
      providerName: input.OUTPOST_OIDC_PROVIDER_NAME!.trim(),
      bridgeSecret,
      subjectIdentityEnabled: input.OUTPOST_OIDC_SUBJECT_IDENTITY_ENABLED ?? false,
      enrollment,
    },
  }
}

export function parseOidcEnrollmentConfig(
  rawMode: string | undefined,
  rawMappings: string | undefined,
): OidcEnrollmentConfig {
  const mode = rawMode?.trim() || 'invite_only'
  if (mode !== 'invite_only' && mode !== 'mapped') {
    throw new Error('OUTPOST_OIDC_ENROLLMENT_MODE must be invite_only or mapped')
  }
  if (mode === 'invite_only') return { mode }
  if (!rawMappings?.trim()) {
    throw new Error('OUTPOST_OIDC_WORKSPACE_MAPPINGS is required when OUTPOST_OIDC_ENROLLMENT_MODE=mapped')
  }
  if (Buffer.byteLength(rawMappings, 'utf8') > 32 * 1024) {
    throw new Error('OUTPOST_OIDC_WORKSPACE_MAPPINGS is too large')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawMappings)
  } catch {
    throw new Error('OUTPOST_OIDC_WORKSPACE_MAPPINGS must be valid JSON')
  }
  if (!isRecord(parsed) || hasUnknownKeys(parsed, ['version', 'groupClaim', 'additionalScopes', 'rules'])) {
    throw new Error('OUTPOST_OIDC_WORKSPACE_MAPPINGS has an invalid shape')
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.rules) || parsed.rules.length < 1 || parsed.rules.length > 128) {
    throw new Error('OUTPOST_OIDC_WORKSPACE_MAPPINGS requires version 1 and 1-128 rules')
  }

  let groupClaim: string | undefined
  if (parsed.groupClaim !== undefined) {
    if (typeof parsed.groupClaim !== 'string' || parsed.groupClaim.length < 1 || parsed.groupClaim.length > 200 || parsed.groupClaim.trim() !== parsed.groupClaim || /[\x00-\x1f\x7f]/.test(parsed.groupClaim)) {
      throw new Error('OUTPOST_OIDC_WORKSPACE_MAPPINGS groupClaim is invalid')
    }
    groupClaim = parsed.groupClaim
  }

  const rawScopes = parsed.additionalScopes ?? []
  if (!Array.isArray(rawScopes) || rawScopes.length > 16 || rawScopes.some((scope) => typeof scope !== 'string' || !SCOPE_RE.test(scope))) {
    throw new Error('OUTPOST_OIDC_WORKSPACE_MAPPINGS additionalScopes are invalid')
  }
  const additionalScopes = [...new Set(rawScopes as string[])].filter((scope) => !['openid', 'email', 'profile'].includes(scope))

  const rules = parsed.rules.map((raw): OidcWorkspaceMappingRule => {
    if (!isRecord(raw) || hasUnknownKeys(raw, ['emailDomain', 'group', 'workspaceId'])) {
      throw new Error('OUTPOST_OIDC_WORKSPACE_MAPPINGS contains an invalid rule')
    }
    if (typeof raw.workspaceId !== 'string' || !UUID_RE.test(raw.workspaceId)) {
      throw new Error('OUTPOST_OIDC_WORKSPACE_MAPPINGS workspaceId must be a UUID')
    }
    const hasDomain = raw.emailDomain !== undefined
    const hasGroup = raw.group !== undefined
    if (hasDomain === hasGroup) {
      throw new Error('OUTPOST_OIDC_WORKSPACE_MAPPINGS rules require exactly one of emailDomain or group')
    }
    if (hasDomain) {
      if (typeof raw.emailDomain !== 'string') throw new Error('OUTPOST_OIDC_WORKSPACE_MAPPINGS emailDomain is invalid')
      const emailDomain = normalizeEmailDomain(raw.emailDomain)
      return { emailDomain, workspaceId: raw.workspaceId.toLowerCase() }
    }
    if (!groupClaim) throw new Error('OUTPOST_OIDC_WORKSPACE_MAPPINGS groupClaim is required for group rules')
    if (typeof raw.group !== 'string' || raw.group.length < 1 || raw.group.length > 200 || raw.group.trim() !== raw.group || /[\x00-\x1f\x7f]/.test(raw.group)) {
      throw new Error('OUTPOST_OIDC_WORKSPACE_MAPPINGS group is invalid')
    }
    return { group: raw.group, workspaceId: raw.workspaceId.toLowerCase() }
  })

  return {
    mode,
    ...(groupClaim ? { groupClaim } : {}),
    additionalScopes,
    rules,
  }
}

export function matchedOidcWorkspaceIds(
  enrollment: OidcEnrollmentConfig,
  identity: { email?: string; groups?: string[]; groupClaim?: string },
): string[] {
  if (enrollment.mode !== 'mapped') return []
  const rawEmailDomain = identity.email?.split('@').at(-1)
  const emailDomain = rawEmailDomain ? domainToASCII(rawEmailDomain).toLowerCase() : undefined
  const groups = new Set(enrollment.groupClaim === identity.groupClaim ? identity.groups ?? [] : [])
  return [...new Set(enrollment.rules
    .filter((rule) => (rule.emailDomain !== undefined && rule.emailDomain === emailDomain)
      || (rule.group !== undefined && groups.has(rule.group)))
    .map((rule) => rule.workspaceId))]
}

function normalizeEmailDomain(raw: string): string {
  if (raw.trim() !== raw || raw.length > 253 || raw.includes('@')) {
    throw new Error('OUTPOST_OIDC_WORKSPACE_MAPPINGS emailDomain is invalid')
  }
  const domain = domainToASCII(raw).toLowerCase()
  const labels = domain.split('.')
  if (labels.length < 2 || labels.some((label) => !/^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))) {
    throw new Error('OUTPOST_OIDC_WORKSPACE_MAPPINGS emailDomain is invalid')
  }
  return domain
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasUnknownKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).some((key) => !allowed.includes(key))
}

function requireValues(
  input: OutpostAuthConfigInput,
  names: Array<keyof OutpostAuthConfigInput>,
  provider: string,
): void {
  const missing = names.filter((name) => {
    const value = input[name]
    return typeof value !== 'string' || value.trim() === ''
  })
  if (missing.length > 0) {
    throw new Error(`${provider} requires ${missing.join(', ')}`)
  }
}
