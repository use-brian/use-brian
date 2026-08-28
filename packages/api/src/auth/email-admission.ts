export type EmailAdmissionUser = { authProvider: string } | null

export function requireOutpostAuthPortal(profile: string, authPortalUrl: string | undefined): void {
  if (profile === 'outpost' && !authPortalUrl?.trim()) {
    throw new Error('AUTH_PORTAL_URL is required when USEBRIAN_EDITION=outpost')
  }
}

export function createEmailAdmission(options: {
  outpost: boolean
  bootstrapEmails: Iterable<string>
  findUser: (email: string) => Promise<EmailAdmissionUser>
  hasPendingInvitation: (email: string) => Promise<boolean>
}): (email: string) => Promise<boolean> {
  const bootstrap = new Set([...options.bootstrapEmails].map((email) => email.trim().toLowerCase()).filter(Boolean))
  return async (email) => {
    if (!options.outpost) return true
    const normalized = email.trim().toLowerCase()
    if (bootstrap.has(normalized)) return true
    const existing = await options.findUser(normalized)
    if (existing && existing.authProvider !== 'channel') return true
    return options.hasPendingInvitation(normalized)
  }
}
