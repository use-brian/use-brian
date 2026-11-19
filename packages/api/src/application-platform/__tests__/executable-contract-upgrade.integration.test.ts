/** Before/after the real maintained8274 boundary, on an explicitly owned fixture. */
import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { getPool } from '../../db/client.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
const { authenticateConversationInstallation, currentInstallationAuthenticationSource, currentFunctionCount } = await import(new URL('../../../scripts/conversation-store/installation-authentication.mjs', import.meta.url).href)
const phase = process.env.BRIAN_EXECUTABLE_CONTRACT_PHASE
const migration = await readFile(new URL('../../../migrations/8274_inputtable_executable_contracts.sql', import.meta.url), 'utf8')
afterAll(async () => { await getPool().end() })

describe.skipIf(phase !== 'before').sequential('[COMP:api/native-turn-frame] original executable consumer classification', () => {
  it.each([
    ['private SQL reader', "CREATE FUNCTION executable_probe.reader() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM public.native_turn_contract_helpers'", 'executable_unreviewed_registry_consumer'],
    ['SQL-standard BEGIN ATOMIC reader', 'CREATE FUNCTION executable_probe.reader() RETURNS bigint LANGUAGE sql BEGIN ATOMIC SELECT count(*) FROM public.native_turn_contract_helpers; END', 'executable_unreviewed_registry_dependency'],
    ['view/rule expression reader', 'CREATE VIEW executable_probe.reader AS SELECT signature FROM public.native_turn_contract_helpers', 'executable_unreviewed_registry_dependency'],
  ])('refuses an unknown %s before representation or registry mutation', async (_name, setup, error) => {
    await assertLocalFixture()
    const client = await getPool().connect()
    try {
      const before = (await client.query('SELECT jsonb_agg(to_jsonb(h) ORDER BY signature COLLATE "C") data FROM native_turn_contract_helpers h')).rows[0].data
      await client.query('CREATE SCHEMA executable_probe;' + setup)
      await expect(client.query(migration)).rejects.toThrow(error)
      await client.query('ROLLBACK')
      expect((await client.query("SELECT to_regtype('public.native_executable_contract_v1') IS NULL absent")).rows[0].absent).toBe(true)
      expect((await client.query('SELECT jsonb_agg(to_jsonb(h) ORDER BY signature COLLATE "C") data FROM native_turn_contract_helpers h')).rows[0].data).toEqual(before)
    } finally { await client.query('ROLLBACK'); await client.query('DROP SCHEMA IF EXISTS executable_probe CASCADE'); client.release() }
  })
})

describe.skipIf(phase !== 'after').sequential('[COMP:api/native-turn-frame] current typed executable receiving boundary', () => {
  it('verifies all311 source functions twice on one ordinary owner connection without public mutation', async () => {
    await assertLocalFixture()
    const client = await getPool().connect()
    try {
      expect((await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false })
      const before = (await client.query('SELECT jsonb_agg(to_jsonb(h) ORDER BY signature COLLATE "C") data FROM native_turn_contract_helpers h')).rows[0].data
      const first = await authenticateConversationInstallation(client), second = await authenticateConversationInstallation(client)
      expect(first).toEqual(second)
      // The head recipe moves with every executable-contract successor.
      expect(first.functions).toBe(currentFunctionCount)
      expect(first.sourceDefinitionDigest).toBe((await currentInstallationAuthenticationSource()).sourceDigest)
      expect((await client.query('SELECT jsonb_agg(to_jsonb(h) ORDER BY signature COLLATE "C") data FROM native_turn_contract_helpers h')).rows[0].data).toEqual(before)
      expect((await client.query('SELECT native_turn_helpers_current() root,native_turn_publication_contract() publication,native_retained_helpers_current() retained,native_conversation_conversion_contract() conversion')).rows[0])
        .toEqual({ root: true, publication: true, retained: true, conversion: true })
    } finally { client.release() }
  })
  it('preserves every executable field through the actual composite text input, including nonnull parse trees', async () => {
    const client = await getPool().connect()
    try {
      const result = (await client.query(`SELECT count(*)::int count,bool_and(to_jsonb(h.contract)=to_jsonb(p)) complete,
        bool_and(h.contract::text::public.native_executable_contract_v1 IS NOT DISTINCT FROM h.contract) inputtable,
        count(*) FILTER(WHERE (h.contract).proargdefaults IS NOT NULL)::int defaults
        FROM native_turn_contract_helpers h JOIN pg_proc p ON p.oid=(h.contract).oid`)).rows[0]
      expect(result.count).toBe(297); expect(result.complete).toBe(true); expect(result.inputtable).toBe(true); expect(result.defaults).toBeGreaterThan(0)
      await client.query('CREATE FUNCTION pg_temp.executable_tree_probe(value integer DEFAULT 7) RETURNS integer LANGUAGE sql BEGIN ATOMIC SELECT value+1; END')
      const { executableProjection } = await import(new URL('../../../scripts/conversation-store/executable-record.mjs', import.meta.url).href)
      const probe = (await client.query(`SELECT to_jsonb((${executableProjection('p')})::text::public.native_executable_contract_v1)=to_jsonb(p) complete,
        p.prosqlbody IS NOT NULL body,p.proargdefaults IS NOT NULL defaults FROM pg_proc p WHERE p.oid='pg_temp.executable_tree_probe(integer)'::regprocedure`)).rows[0]
      expect(probe).toEqual({ complete: true, body: true, defaults: true })
    } finally { await client.query('DROP FUNCTION IF EXISTS pg_temp.executable_tree_probe(integer)'); client.release() }
  })
  it('refuses a malformed composite shape before evaluating its row projection', async () => {
    const client = await getPool().connect()
    try {
      await client.query('ALTER TYPE public.native_executable_contract_v1 RENAME ATTRIBUTE proname TO changed_proname')
      expect((await client.query('SELECT native_turn_helpers_current() value')).rows[0].value).toBe(false)
      await expect(authenticateConversationInstallation(client)).rejects.toThrow('installation_executable_type_shape_changed')
    } finally {
      await client.query('ALTER TYPE public.native_executable_contract_v1 RENAME ATTRIBUTE changed_proname TO proname')
      // Restored content has new tuple versions: authentic, but on the full comparator until refreshed.
      expect((await authenticateConversationInstallation(client)).witnessCurrent).toBe(false)
      expect((await client.query('SELECT native_turn_contract_witness_refresh() value')).rows[0].value).toBe(true)
      expect((await authenticateConversationInstallation(client)).witnessCurrent).toBe(true)
      client.release()
    }
  })
  it('keeps the canonical post-migration runtime-role verification usable', async () => {
    const { runtimeRoleSql } = await import(new URL('../../../../../scripts/crm/runtime-role.mjs', import.meta.url).href)
    await expect(getPool().query(await runtimeRoleSql('verify'))).resolves.toBeDefined()
  })
})
