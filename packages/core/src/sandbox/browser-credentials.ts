/**
 * Browser-login credential ports. The split is the security boundary:
 * profile-management routes receive only `BrowserCredentialAdminStore`,
 * while the host-owned auth broker alone receives
 * `BrowserCredentialResolver` and can therefore decrypt a value.
 *
 * [COMP:sandbox/browser-credentials]
 */

export type BrowserCredentialStatus = 'active' | 'invalid'

export type BrowserCredentialFailureCode =
  | 'auth_unavailable'
  | 'cross_site_redirect'
  | 'human_verification'
  | 'mfa_required'
  | 'field_not_found'
  | 'field_ambiguous'
  | 'submit_not_found'
  | 'login_rejected'
  | 'empty_session'
  | 'backend_error'

/** Metadata safe to return to the browser mini app. */
export type BrowserCredentialMetadata = {
  id: string
  workspaceId: string
  profileId: string
  site: string
  loginUrl: string
  accountLabel: string | null
  status: BrowserCredentialStatus
  lastUsedAt: string | null
  lastFailureCode: BrowserCredentialFailureCode | null
  createdAt: string
  updatedAt: string
}

export type BrowserCredentialSecret = {
  username: string
  password: string
}

export type BrowserCredentialResolved = {
  metadata: BrowserCredentialMetadata
  secret: BrowserCredentialSecret
}

export interface BrowserCredentialAdminStore {
  list(params: { profileId: string }): Promise<BrowserCredentialMetadata[]>
  upsert(params: {
    workspaceId: string
    profileId: string
    ownerUserId: string
    site: string
    loginUrl: string
    accountLabel?: string | null
    secret: BrowserCredentialSecret
  }): Promise<BrowserCredentialMetadata>
  revoke(params: { profileId: string; credentialId: string }): Promise<boolean>
}

export interface BrowserCredentialResolver {
  resolve(params: {
    userId: string
    workspaceId: string
    profileId: string
    site: string
    credentialId?: string
  }): Promise<BrowserCredentialResolved | null>
  recordResult(params: {
    credentialId: string
    result: 'success' | 'failure'
    failureCode?: BrowserCredentialFailureCode
  }): Promise<void>
}

export type BrowserCredentialStore = BrowserCredentialAdminStore & BrowserCredentialResolver
