/** [COMP:api/conversation-visibility] The installed record owner and its
 * restrictive reader boundary must match the reviewed compiler source. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPool, rollbackAndRelease } from '../client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const { buildRecordAdmissionCandidate } = await import(new URL('../../../scripts/conversation-store/build-conversation-record-admission.mjs', import.meta.url).href)
const { currentInstallationAuthenticationSource, recordInstallationSource } = await import(new URL('../../../scripts/conversation-store/installation-authentication-8297.mjs', import.meta.url).href)
let authentication: { sql: string; cleanup: string; functions: number }

beforeAll(async () => {
  const client = await getPool().connect()
  try {
    const installed = await client.query("SELECT to_regprocedure('public.capture_conversation_record_current(uuid,uuid,integer,integer,integer,jsonb)') IS NOT NULL installed")
    if (installed.rows[0].installed) authentication = await currentInstallationAuthenticationSource()
    else {
      const migration = await buildRecordAdmissionCandidate()
      await client.query(migration)
      authentication = await recordInstallationSource(migration)
    }
  } finally { await rollbackAndRelease(client) }
}, 120_000)
afterAll(async () => { await getPool().end() })

describe.sequential('reviewed conversation record installation', () => {
  it('authenticates the closed native profile and the ordinary record helper definitions', async () => {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      const result = await client.query(authentication.sql).catch((error: { message: string; where?: string; position?: string; internalQuery?: string }) => {
        throw new Error([error.message, error.where, error.position, error.internalQuery].filter(Boolean).join(' | '))
      })
      const receipt = (Array.isArray(result) ? result.at(-1) : result)?.rows?.[0]
      expect(receipt).toMatchObject({ functions: authentication.functions, witness_current: true })
      expect(receipt?.local_digest).toMatch(/^[0-9a-f]{64}$/)
      await client.query(authentication.cleanup)
      await client.query('COMMIT')
    } finally { await rollbackAndRelease(client) }
  }, 120_000)

  it('refuses a privileged replacement of the direct session floor', async () => {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await client.query('ALTER POLICY sessions_conversation_envelope_floor ON public.sessions USING (true)')
      await expect(client.query(authentication.sql)).rejects.toThrow('conversation_record_policy_changed: sessions.sessions_conversation_envelope_floor')
    } finally { await rollbackAndRelease(client) }
  }, 120_000)

  it('refuses direct grants on the host-only history reader', async () => {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await client.query('GRANT EXECUTE ON FUNCTION public.read_native_conversation_history(uuid,uuid,integer) TO app_user')
      await expect(client.query(authentication.sql)).rejects.toThrow('conversation_record_helper_acl_changed: read_native_conversation_history')
    } finally { await rollbackAndRelease(client) }
  }, 120_000)
})
