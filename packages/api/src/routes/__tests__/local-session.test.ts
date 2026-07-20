import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  localSessionRoutes,
  isOssEdition,
  type LocalSessionDeps,
} from '../local-session.js'
import { verifyAccessToken, verifyRefreshToken } from '../../auth/jwt.js'
import type { User } from '../../db/users.js'

const JWT_SECRET = 'local-session-test-secret'
const OWNER_ID = '00000000-0000-4000-a000-00000000000e'

function fakeUser(overrides?: Partial<User>): User {
  return {
    id: OWNER_ID,
    email: 'owner@local',
    name: 'You',
    handle: 'owner',
    avatarUrl: null,
    authProvider: 'local',
    authProviderId: 'local-owner',
    plan: 'free',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripePriceId: null,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    paymentFailedAt: null,
    trialUsedAt: null,
    timezone: 'UTC',
    lastSeenTz: null,
    lastSeenTzAt: null,
    createdAt: new Date(),
    ...overrides,
  } as User
}

function makeApp(deps: Partial<LocalSessionDeps>) {
  const app = express()
  app.use(express.json())
  app.use(
    '/auth',
    localSessionRoutes({
      jwtSecret: JWT_SECRET,
      isEnabled: () => true,
      ...deps,
    }),
  )
  return app
}

describe('[COMP:api/local-session] isOssEdition gate', () => {
  it('is true when USEBRIAN_EDITION=oss', () => {
    const prev = process.env.USEBRIAN_EDITION
    try {
      process.env.USEBRIAN_EDITION = 'oss'
      expect(isOssEdition()).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.USEBRIAN_EDITION
      else process.env.USEBRIAN_EDITION = prev
    }
  })

  it('is true when NEXT_PUBLIC_USEBRIAN_EDITION=oss (the launcher app-web var)', () => {
    const prev = { s: process.env.USEBRIAN_EDITION, n: process.env.NEXT_PUBLIC_USEBRIAN_EDITION }
    try {
      delete process.env.USEBRIAN_EDITION
      process.env.NEXT_PUBLIC_USEBRIAN_EDITION = 'oss'
      expect(isOssEdition()).toBe(true)
    } finally {
      if (prev.s === undefined) delete process.env.USEBRIAN_EDITION
      else process.env.USEBRIAN_EDITION = prev.s
      if (prev.n === undefined) delete process.env.NEXT_PUBLIC_USEBRIAN_EDITION
      else process.env.NEXT_PUBLIC_USEBRIAN_EDITION = prev.n
    }
  })

  it('defaults to false (hosted) when unset, so a hosted deploy never opts in', () => {
    const prev = { s: process.env.USEBRIAN_EDITION, n: process.env.NEXT_PUBLIC_USEBRIAN_EDITION }
    try {
      delete process.env.USEBRIAN_EDITION
      delete process.env.NEXT_PUBLIC_USEBRIAN_EDITION
      expect(isOssEdition()).toBe(false)
    } finally {
      if (prev.s !== undefined) process.env.USEBRIAN_EDITION = prev.s
      if (prev.n !== undefined) process.env.NEXT_PUBLIC_USEBRIAN_EDITION = prev.n
    }
  })
})

describe('[COMP:api/local-session] POST /auth/local-session', () => {
  it('refuses with 403 and never mints a token when the local+oss gate is closed', async () => {
    const createUser = vi.fn()
    const app = makeApp({ isEnabled: () => false, createUser })
    const res = await request(app).post('/auth/local-session').expect(403)
    expect(res.body).toEqual({ error: 'local_session_disabled' })
    expect(createUser).not.toHaveBeenCalled()
  })

  it('returns 503 when JWT_SECRET is unset rather than signing with undefined', async () => {
    const createUser = vi.fn()
    const app = makeApp({ jwtSecret: undefined, createUser })
    await request(app).post('/auth/local-session').expect(503)
    expect(createUser).not.toHaveBeenCalled()
  })

  it('mints a verifiable pair for the neutral local-owner with the configured name', async () => {
    const createUser = vi.fn(async () => ({ user: fakeUser({ name: 'Hinson' }), isNew: false }))
    const app = makeApp({ ownerName: 'Hinson', createUser })
    const res = await request(app).post('/auth/local-session').expect(200)

    expect(verifyAccessToken(res.body.accessToken, JWT_SECRET)).toBe(OWNER_ID)
    expect(verifyRefreshToken(res.body.refreshToken, JWT_SECRET)).toBe(OWNER_ID)
    // The identity is the neutral owner — never "Local Dev"/dev@localhost.
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        authProvider: 'local',
        authProviderId: 'local-owner',
        email: 'owner@local',
        name: 'Hinson',
      }),
    )
  })

  it('falls back to the default owner name "You" when none is configured', async () => {
    const createUser = vi.fn(async () => ({ user: fakeUser(), isNew: false }))
    const app = makeApp({ createUser })
    await request(app).post('/auth/local-session').expect(200)
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({ name: 'You' }))
  })

  it('also accepts GET (launcher opens the URL in the browser)', async () => {
    const createUser = vi.fn(async () => ({ user: fakeUser(), isNew: false }))
    const app = makeApp({ createUser })
    await request(app).get('/auth/local-session').expect(200)
    expect(createUser).toHaveBeenCalledOnce()
  })
})
