/** [COMP:tooling/m6-qualification] Fixture-only canonical user/device/JWT setup.
 * The ephemeral access token travels only over private child IPC. */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.BRIAN_ACCEPTANCE_OSS_ROOT
if (!root || !process.env.JWT_SECRET || !process.send) throw new Error('provision-auth requires an owned fixture and private IPC')
const { assertLocalFixture } = await import(pathToFileURL(join(root, 'scripts/crm/local-fixture.mjs')).href)
await assertLocalFixture()
const built = path => import(pathToFileURL(join(root, 'packages/api/dist', path)).href)
const [{ findOrCreateUser }, { authSessionStore }, { createTokens }, { getPool, getAppPool }] = await Promise.all([
  built('db/users.js'), built('db/auth-session-store.js'), built('auth/jwt.js'), built('db/client.js'),
])
try {
  const tokens = {}
  for (const actor of ['owner', 'outsider']) {
    const { user } = await findOrCreateUser({ authProvider: 'local', authProviderId: `m6-fictional-runtime-${actor}`,
      email: `runtime-${actor}@example.test`, name: `Fixture Runtime ${actor}` })
    if (actor === 'owner' && process.env.BRIAN_ACCEPTANCE_HOSTED_PLAN === 'pro') {
      const updated = await getPool().query(`UPDATE workspaces SET plan='pro' WHERE owner_user_id=$1`, [user.id])
      if (updated.rowCount !== 1) throw new Error('Expected one fictional workspace for the local hosted plan')
    }
    const session = await authSessionStore.create(user.id, { deviceLabel: 'Fictional acceptance browser', userAgent: null, ipAddress: null })
    if (!session) throw new Error('fixture auth session could not be created')
    tokens[actor] = createTokens(user.id, process.env.JWT_SECRET, session).accessToken
  }
  process.send({ type: 'fixture-auth', accessToken: tokens.owner, outsiderAccessToken: tokens.outsider })
} finally { await Promise.allSettled([getPool().end(), getAppPool().end()]) }
