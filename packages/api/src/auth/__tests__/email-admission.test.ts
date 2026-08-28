import { describe, expect, it, vi } from 'vitest'
import { createEmailAdmission, requireOutpostAuthPortal } from '../email-admission.js'

describe('[COMP:app/outpost-auth] Outpost email admission', () => {
  const make = (user: { authProvider: string } | null, invited = false) => createEmailAdmission({
    outpost: true,
    bootstrapEmails: ['Admin@Example.com'],
    findUser: vi.fn(async () => user),
    hasPendingInvitation: vi.fn(async () => invited),
  })

  it('admits bootstrap administrators, existing login users, and invitees', async () => {
    await expect(make(null)('admin@example.com')).resolves.toBe(true)
    await expect(make({ authProvider: 'email' })('member@example.com')).resolves.toBe(true)
    await expect(make(null, true)('invitee@example.com')).resolves.toBe(true)
  })

  it('does not treat a channel shadow as an existing login account', async () => {
    await expect(make({ authProvider: 'channel' })('shadow@example.com')).resolves.toBe(false)
  })

  it('leaves non-Outpost authentication policy unchanged', async () => {
    const admit = createEmailAdmission({ outpost: false, bootstrapEmails: [], findUser: vi.fn(), hasPendingInvitation: vi.fn() })
    await expect(admit('anyone@example.com')).resolves.toBe(true)
  })

  it('requires an explicit auth portal in Outpost only', () => {
    expect(() => requireOutpostAuthPortal('outpost', undefined)).toThrow(/AUTH_PORTAL_URL/)
    expect(() => requireOutpostAuthPortal('outpost', 'https://auth.example')).not.toThrow()
    expect(() => requireOutpostAuthPortal('hosted', undefined)).not.toThrow()
  })
})
