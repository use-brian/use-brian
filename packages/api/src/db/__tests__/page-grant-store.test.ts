import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { hashShareToken, type ResolvedLink } from '../page-grant-store.js'
import { createPageAccessResolver } from '../page-access.js'

describe('[COMP:doc/page-grants] Page grants + access resolver', () => {
  describe('hashShareToken', () => {
    it('persists only the SHA-256 hash (never the raw token), deterministic', () => {
      const raw = 'a-very-secret-link-token'
      expect(hashShareToken(raw)).toBe(createHash('sha256').update(raw).digest('hex'))
      expect(hashShareToken(raw)).toBe(hashShareToken(raw))
      expect(hashShareToken(raw)).not.toContain(raw)
      expect(hashShareToken(raw)).toHaveLength(64) // hex sha256
    })
  })

  describe('createPageAccessResolver — link branch', () => {
    const resolverWith = (link: ResolvedLink | null) =>
      createPageAccessResolver({
        pageGrantStore: {
          createLinkGrant: async () => {
            throw new Error('not used')
          },
          listGrants: async () => [],
          listIdentityGrants: async () => [],
          upsertIdentityGrant: async () => {
            throw new Error('not used')
          },
          updateGrantRole: async () => false,
          revokeGrant: async () => false,
          resolveLinkToken: async () => link,
          resolveLinkPage: async () => link,
          getPublishState: async () => ({ published: false, indexable: false }),
          publishPage: async () => {},
          unpublishPage: async () => false,
          resolvePublishedPage: async () => link,
        },
      })

    const link: ResolvedLink = {
      pageId: 'p1',
      workspaceId: 'w1',
      title: 'Research',
      icon: null,
      fullWidth: false,
      role: 'view',
      indexable: false,
    }

    it('resolves a live link token to its role + page', async () => {
      const access = await resolverWith(link).resolve({ kind: 'link', rawToken: 'tok' })
      expect(access).toEqual({ role: 'view', pageId: 'p1', workspaceId: 'w1' })
    })

    it('returns null for an unknown/revoked/expired/non-public token', async () => {
      expect(await resolverWith(null).resolve({ kind: 'link', rawToken: 'tok' })).toBeNull()
    })

    it('binds a token to its page (a link for page A cannot open page B)', async () => {
      expect(await resolverWith(link).resolve({ kind: 'link', rawToken: 'tok' }, 'p2')).toBeNull()
      // ...but resolves when the page matches
      expect(await resolverWith(link).resolve({ kind: 'link', rawToken: 'tok' }, 'p1')).not.toBeNull()
    })

    it('stubs the user/service principals (Phase 3 — never reached by anon links)', async () => {
      expect(await resolverWith(null).resolve({ kind: 'user', userId: 'u1' })).toBeNull()
      expect(await resolverWith(null).resolve({ kind: 'service' })).toBeNull()
    })
  })
})
