export type OutpostAuthConfigInput = {
  OUTPOST_AUTH_EMAIL_ENABLED?: boolean
  OUTPOST_AUTH_OIDC_ENABLED?: boolean
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
  }
}

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

  return {
    emailEnabled,
    oidcEnabled,
    oidc: {
      issuerUrl,
      clientId: input.OUTPOST_OIDC_CLIENT_ID!.trim(),
      clientSecret: input.OUTPOST_OIDC_CLIENT_SECRET!.trim(),
      providerName: input.OUTPOST_OIDC_PROVIDER_NAME!.trim(),
      bridgeSecret,
    },
  }
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
