import { describe, expect, it } from 'vitest'
import { matchedOidcWorkspaceIds, parseOidcEnrollmentConfig, parseStrictBoolean, validateOutpostAuthConfig } from '../outpost-auth-config.js'

const smtp = {
  GMAIL_SMTP_USER: 'mailer@example.com',
  GMAIL_SMTP_APP_PASSWORD: 'app-password',
  EMAIL_FROM_ADDRESS: 'auth@example.com',
}

const oidc = {
  OUTPOST_OIDC_ISSUER_URL: 'https://id.example.com/tenant',
  OUTPOST_OIDC_CLIENT_ID: 'client-id',
  OUTPOST_OIDC_CLIENT_SECRET: 'client-secret',
  OUTPOST_OIDC_PROVIDER_NAME: 'Company SSO',
  OUTPOST_AUTH_BRIDGE_SECRET: 'a'.repeat(32),
}

describe('[COMP:app/outpost-auth] Outpost auth configuration', () => {
  const workspaceOne = '11111111-1111-4111-8111-111111111111'
  const workspaceTwo = '22222222-2222-4222-8222-222222222222'
  it('uses email-on and OIDC-off defaults in Outpost', () => {
    expect(validateOutpostAuthConfig('outpost', 'production', smtp)).toMatchObject({
      emailEnabled: true,
      oidcEnabled: false,
    })
  })

  it('does not enforce Outpost provider configuration in other profiles', () => {
    expect(validateOutpostAuthConfig('hosted', 'production', {
      OUTPOST_AUTH_EMAIL_ENABLED: false,
      OUTPOST_AUTH_OIDC_ENABLED: false,
    })).toBeUndefined()
  })

  it('rejects both providers disabled and incomplete enabled providers', () => {
    expect(() => validateOutpostAuthConfig('outpost', 'production', {
      OUTPOST_AUTH_EMAIL_ENABLED: false,
      OUTPOST_AUTH_OIDC_ENABLED: false,
    })).toThrow(/at least one/)
    expect(() => validateOutpostAuthConfig('outpost', 'production', {
      OUTPOST_AUTH_EMAIL_ENABLED: true,
    })).toThrow(/GMAIL_SMTP_USER/)
    expect(() => validateOutpostAuthConfig('outpost', 'production', {
      OUTPOST_AUTH_EMAIL_ENABLED: false,
      OUTPOST_AUTH_OIDC_ENABLED: true,
      ...oidc,
      OUTPOST_OIDC_PROVIDER_NAME: '',
    })).toThrow(/OUTPOST_OIDC_PROVIDER_NAME/)
  })

  it('accepts complete OIDC and requires production HTTPS plus a 32-character bridge secret', () => {
    expect(validateOutpostAuthConfig('outpost', 'production', {
      OUTPOST_AUTH_EMAIL_ENABLED: false,
      OUTPOST_AUTH_OIDC_ENABLED: true,
      ...oidc,
    })?.oidc).toMatchObject({ issuerUrl: oidc.OUTPOST_OIDC_ISSUER_URL, subjectIdentityEnabled: false })
    expect(validateOutpostAuthConfig('outpost', 'production', {
      OUTPOST_AUTH_EMAIL_ENABLED: false,
      OUTPOST_AUTH_OIDC_ENABLED: true,
      OUTPOST_OIDC_SUBJECT_IDENTITY_ENABLED: true,
      ...oidc,
    })?.oidc?.subjectIdentityEnabled).toBe(true)
    expect(() => validateOutpostAuthConfig('outpost', 'production', {
      OUTPOST_AUTH_EMAIL_ENABLED: false,
      OUTPOST_AUTH_OIDC_ENABLED: true,
      ...oidc,
      OUTPOST_OIDC_ISSUER_URL: 'http://id.example.com',
    })).toThrow(/HTTPS/)
    expect(() => validateOutpostAuthConfig('outpost', 'development', {
      OUTPOST_AUTH_EMAIL_ENABLED: false,
      OUTPOST_AUTH_OIDC_ENABLED: true,
      ...oidc,
      OUTPOST_AUTH_BRIDGE_SECRET: 'short',
    })).toThrow(/32 characters/)
  })

  it('strictly parses direct-entry booleans without default drift', () => {
    expect(parseStrictBoolean(undefined, 'FLAG', true)).toBe(true)
    expect(parseStrictBoolean(undefined, 'FLAG', false)).toBe(false)
    expect(parseStrictBoolean(' true ', 'FLAG', false)).toBe(true)
    expect(parseStrictBoolean('1', 'FLAG', false)).toBe(true)
    expect(parseStrictBoolean('false', 'FLAG', true)).toBe(false)
    expect(parseStrictBoolean('0', 'FLAG', true)).toBe(false)
    expect(() => parseStrictBoolean('', 'FLAG', true)).toThrow(/FLAG/)
    expect(() => parseStrictBoolean('yes', 'FLAG', true)).toThrow(/FLAG/)
  })

  it('parses bounded exact domain and group workspace mappings', () => {
    const enrollment = parseOidcEnrollmentConfig('mapped', JSON.stringify({
      version: 1,
      groupClaim: 'groups',
      additionalScopes: ['groups', 'groups', 'openid'],
      rules: [
        { emailDomain: 'EXAMPLE.COM', workspaceId: workspaceOne },
        { group: 'Engineering', workspaceId: workspaceTwo },
      ],
    }))
    expect(enrollment).toMatchObject({ mode: 'mapped', additionalScopes: ['groups'] })
    expect(matchedOidcWorkspaceIds(enrollment, { email: 'user@example.com', groups: ['Engineering'], groupClaim: 'groups' }))
      .toEqual([workspaceOne, workspaceTwo])
    expect(matchedOidcWorkspaceIds(enrollment, { email: 'user@example.com.attacker.test', groups: ['engineering'], groupClaim: 'groups' }))
      .toEqual([])
  })

  it('rejects malformed or ambiguous workspace mappings', () => {
    expect(() => parseOidcEnrollmentConfig('mapped', undefined)).toThrow(/required/)
    expect(() => parseOidcEnrollmentConfig('other', '{}')).toThrow(/invite_only or mapped/)
    expect(() => parseOidcEnrollmentConfig('mapped', JSON.stringify({ version: 1, rules: [
      { emailDomain: 'example.com', group: 'engineering', workspaceId: workspaceOne },
    ] }))).toThrow(/exactly one/)
    expect(() => parseOidcEnrollmentConfig('mapped', JSON.stringify({ version: 1, rules: [
      { group: 'engineering', workspaceId: workspaceOne },
    ] }))).toThrow(/groupClaim/)
  })
})
