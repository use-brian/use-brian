/** Fused admission owner (migration 8289) at its real boundary: app_user captures
 * inside the retained session-context frame, the fused owner against the generic
 * owner (the exact predecessor body), registry tamper, the two-role model and the
 * installation authenticator. [COMP:api/fused-admission] */
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import { getPool } from '../../db/client.js'
import { createMemory } from '../../db/memories.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { addSessionMessage, createPersonalWebSession } from '../../db/sessions.js'
import { publishNativeSessionMessageBatch, readAdmittedSessionQuery } from '../../db/conversation-store.js'
import { readRetainedContextFrame } from '../../db/session-context-revisions.js'
import { resolveSessionTitleAuthority } from '../../routes/session-title-authority.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const store = fileURLToPath(new URL('../../../scripts/conversation-store/', import.meta.url))

type Result = { ok: true; value: unknown } | { ok: false; code: string; message: string }
const fixtures: Array<{ cleanup(): Promise<void> }> = []
// Test-only entry points on the disposable fixture: the generic owner and the
// compiled path alone (a route to the generic owner raises), both for app_user.
const shims = ['admission_test_generic(uuid,jsonb)', 'admission_test_compiled(uuid,jsonb)']
afterAll(async () => {
  for (const f of fixtures) await f.cleanup()
  for (const s of shims) await getPool().query(`DROP FUNCTION IF EXISTS ${s}`)
})

async function setup() {
  const f = await persistentContextFixture('confidential'); fixtures.push(f)
  const pool = getPool()
  const pin = (await pool.query<{ h: string }>("SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') h FROM pg_proc p WHERE p.oid='native_turn_helpers_current()'::regprocedure")).rows[0].h
  await pool.query(`CREATE OR REPLACE FUNCTION admission_test_generic(w uuid,roots jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
   BEGIN RETURN capture_conversation_evidence_generic(w,roots,NULL,NULL); END $$`)
  await pool.query(`CREATE OR REPLACE FUNCTION admission_test_compiled(w uuid,roots jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
   DECLARE r jsonb; BEGIN r:=fused_f_capture(w,roots,NULL,NULL,'${pin}');
   IF r IS NOT DISTINCT FROM '{"fusedRoute":"generic"}'::jsonb THEN RAISE EXCEPTION 'admission_test_routed'; END IF; RETURN r; END $$`)
  for (const s of shims) { await pool.query(`REVOKE ALL ON FUNCTION ${s} FROM PUBLIC`); await pool.query(`GRANT EXECUTE ON FUNCTION ${s} TO app_user`) }
  const device = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional fused browser', userAgent: null, ipAddress: null }))!
  const claims = { userId: f.ownerId, sessionId: device.id, authVersion: device.authVersion }
  const session = await createPersonalWebSession({ assistantId: f.assistantId, userId: f.ownerId, workspaceId: f.workspaceId, channelType: 'web',
    channelId: randomUUID(), appOrigin: 'chat' }, { actorUserId: f.ownerId, authSessionId: device.id, authVersion: device.authVersion })
  const authority = () => resolveSessionTitleAuthority({ claims, sessionId: session.id, readOnly: false })
  const input = await addSessionMessage({ sessionId: session.id, role: 'user', content: [{ type: 'text', text: 'Remember the amber notebook.' }],
    senderUserId: f.ownerId, scope: { ...f.envelope, userId: f.ownerId } })
  const history = await readAdmittedSessionQuery({ sessionId: session.id, throughSequence: input.sequenceNum, authority: await authority() })
  await publishNativeSessionMessageBatch({ sessionId: session.id, authority: await authority(), derivationTarget: { ...f.envelope, userId: f.ownerId },
    derivation: { producer: 'fixture:fused-admission', sources: boundScopeSources(history) },
    messages: [{ role: 'assistant', senderAssistantId: f.assistantId, content: [{ type: 'text', text: 'The notebook is amber.' }] }] })
  const roots = JSON.stringify(boundScopeSources(history).map(s => ({ kind: s.resourceKind, id: s.resourceId, version: s.version })))
  return { f, pool, session, input, roots, authority }
}
type Fixture = Awaited<ReturnType<typeof setup>>
const call = async (client: PoolClient, sql: string, values: unknown[]): Promise<Result> => {
  await client.query('SAVEPOINT fused_case')
  try { const value = (await client.query(sql, values)).rows[0].value; await client.query('RELEASE SAVEPOINT fused_case'); return { ok: true, value } }
  catch (error) { await client.query('ROLLBACK TO SAVEPOINT fused_case'); const e = error as { code: string; message: string }; return { ok: false, code: e.code, message: e.message } }
}
/** The installed capture (fused), the generic owner and the compiled path alone, in one frame. */
async function evaluate(x: Fixture) {
  return readRetainedContextFrame(await x.authority(), [], async client => ({
    fused: await call(client, 'SELECT capture_conversation_evidence($1,$2) AS value', [x.f.workspaceId, x.roots]),
    generic: await call(client, 'SELECT admission_test_generic($1,$2) AS value', [x.f.workspaceId, x.roots]),
    compiled: await call(client, 'SELECT admission_test_compiled($1,$2) AS value', [x.f.workspaceId, x.roots]),
  }))
}

describe.sequential('[COMP:api/fused-admission] fused admission owner', () => {
  it('authenticates the installation: 392 functions, the witness current, the 8287 recipe refused', async () => {
    const head = await import(store + 'installation-authentication.mjs'), frozen = await import(store + 'installation-authentication-8287.mjs')
    expect(head.currentFunctionCount).toBe(392)
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL }); await client.connect()
    try {
      // Other suites on the same fixture may change catalog rows in the witness set;
      // a stale witness is a slower guard, never an admission. Start current.
      expect((await client.query<{ ok: boolean }>('SELECT native_turn_contract_witness_refresh() AS ok')).rows[0].ok).toBe(true)
      const first = await head.authenticateConversationInstallation(client), second = await head.authenticateConversationInstallation(client)
      expect(first).toEqual(second); expect(first.functions).toBe(392); expect(first.witnessCurrent).toBe(true)
      await expect(frozen.authenticateConversationInstallation(client)).rejects.toThrow(/conversion_predecessor_changed: capture_conversation_evidence/)
      expect((await client.query("SELECT count(*)::int n FROM native_turn_contract_helpers WHERE signature LIKE 'fused\\_%' OR signature LIKE 'capture_conversation_evidence_generic%'")).rows[0].n).toBe(76)
    } finally { await client.end() }
  })
  it('admits exactly as the generic owner, on the compiled path', async () => {
    const x = await setup(), r = await evaluate(x)
    expect(r.fused.ok && (r.fused.value as { admitted?: boolean }).admitted).toBe(true)
    expect(r.fused).toEqual(r.generic)
    expect(r.compiled).toEqual(r.generic)
  })
  it('refuses exactly as the generic owner when the input is held, a review hold applies or the actor narrows', async () => {
    let compared = 0, frames = 0
    for (const mutate of [
      (x: Fixture) => x.pool.query('UPDATE session_messages SET scope_held=true WHERE workspace_id=$1 AND id=$2', [x.f.workspaceId, x.input.id]),
      (x: Fixture) => x.pool.query("INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason) SELECT $1,'session_message',id,scope_version::text,'held',1,'fixture' FROM session_messages WHERE workspace_id=$1 AND id=$2", [x.f.workspaceId, x.input.id]),
      (x: Fixture) => x.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id<>$2", [x.f.workspaceId, x.f.ownerId]),
    ]) {
      const x = await setup(); await mutate(x)
      const r = await evaluate(x).catch((error: Error) => ({ frame: error.message }))
      if ('frame' in r) { frames++; continue }
      compared++
      expect(r.fused).toEqual(r.generic)
      if (r.compiled.ok) expect(r.compiled).toEqual(r.generic)
    }
    // A change the frame itself refuses never reaches either owner; at least the holds do.
    expect(compared).toBeGreaterThanOrEqual(2); expect(compared + frames).toBe(3)
  })
  it('returns null (empty) exactly as the generic owner when another owner decides the roots', async () => {
    const x = await setup()
    for (const roots of [JSON.stringify([{ kind: 'application_query_domain', id: randomUUID(), version: '1' }]), '[]']) {
      const r = await readRetainedContextFrame(await x.authority(), [], async client => ({
        fused: await call(client, 'SELECT capture_conversation_evidence($1,$2) AS value', [x.f.workspaceId, roots]),
        generic: await call(client, 'SELECT admission_test_generic($1,$2) AS value', [x.f.workspaceId, roots]),
      }))
      expect(r.fused).toEqual({ ok: true, value: null })
      expect(r.fused).toEqual(r.generic)
    }
  })
  it('answers a shape it does not compile (Memory candidates) with the generic owner', async () => {
    const x = await setup()
    const memory = await createMemory({ workspaceId: x.f.workspaceId, userId: x.f.ownerId, assistantId: x.f.assistantId,
      createdByUserId: x.f.ownerId, summary: 'Fictional retained memory', sensitivity: 'public', scope: 'workspace' })
    expect(memory.userId).toBe(x.f.ownerId)
    const r = await evaluate(x)
    expect(r.fused).toEqual(r.generic)
  })
  it('refuses when a fused member or the generic owner changes, and admits again after revert', async () => {
    const x = await setup()
    for (const member of ['fused_l_point(jsonb,uuid,text,uuid,text[],jsonb,jsonb,jsonb[])', 'fused_c_visible(jsonb,uuid,jsonb)', 'capture_conversation_evidence_generic(uuid,jsonb,jsonb,jsonb)']) {
      const cost = (await x.pool.query<{ c: number }>(`SELECT procost c FROM pg_proc WHERE oid='${member}'::regprocedure`)).rows[0].c
      await x.pool.query(`ALTER FUNCTION ${member} COST ${cost + 1}`)
      try {
        const r = await evaluate(x)
        expect(r.fused).toMatchObject({ ok: false, code: '42501', message: 'scope_source_changed' })
      } finally { await x.pool.query(`ALTER FUNCTION ${member} COST ${cost}`) }
      expect((await evaluate(x)).fused.ok).toBe(true)
    }
    // The reverted catalog rows have new tuple versions: the guard took its full
    // comparator. Leave the fixture with a current witness (owner-only refresh).
    expect((await x.pool.query<{ ok: boolean }>('SELECT native_turn_contract_witness_refresh() AS ok')).rows[0].ok).toBe(true)
  })
  it('keeps the two-role model: app_user executes no member, an owner login is refused', async () => {
    const x = await setup()
    const denied = await readRetainedContextFrame(await x.authority(), [], async client => [
      await call(client, "SELECT fused_f_capture($1,$2,NULL,NULL,repeat('0',64)) AS value", [x.f.workspaceId, x.roots]),
      await call(client, 'SELECT capture_conversation_evidence_generic($1,$2,NULL,NULL) AS value', [x.f.workspaceId, x.roots]),
      await call(client, "SELECT (SELECT v FROM fused_c_scope_valid('{}'::jsonb)) AS value", []),
    ])
    for (const r of denied) expect(r).toMatchObject({ ok: false, code: '42501' })
    const owner = await x.pool.connect()
    try {
      await owner.query('BEGIN'); await owner.query("SELECT set_config('app.current_user_id',$1,true)", [x.f.ownerId])
      const r = await call(owner, 'SELECT capture_conversation_evidence($1,$2) AS value', [x.f.workspaceId, x.roots])
      expect(r).toMatchObject({ ok: false, code: '42501', message: 'access_unavailable' })
    } finally { await owner.query('ROLLBACK'); owner.release() }
  })
})
