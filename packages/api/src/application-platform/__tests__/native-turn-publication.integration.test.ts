import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { boundScopeSources } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { readAdmittedSessionQuery } from '../../db/session-query-reader.js'
import { publishNativeSessionMessageBatch } from '../../db/session-message-publication.js'
import { withSessionMessagePublication } from '../../db/session-context-revisions.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/native-turn-frame] shared publication dependencies', () => {
  let fixture: Awaited<ReturnType<typeof persistentContextFixture>> | undefined
  afterEach(async () => { await fixture?.cleanup(); fixture = undefined })
  afterAll(async () => { await getAppPool().end(); await getPool().end() })
  async function setup(count = 3) {
    fixture = await persistentContextFixture()
    const f = fixture
    const history = await f.history()
    const authority = await f.modelContext(f.firstId)
    const input = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: 3, authority })
    const sources = boundScopeSources(input)
    return { f, sources, authority, firstMessageId: history[0].id, command: { sessionId: f.session.id, authority, derivationTarget: f.envelope,
      derivation: { producer: 'fixture:shared-turn-publication', sources },
      messages: Array.from({ length: count }, (_, index) => ({ role: 'assistant', content: `Fictional framed reply ${index}` })) } }
  }
  it.each([1, 3, 7])('commits %s outputs with one shared manifest and no pending completion debt', async count => {
    const { f, command, sources } = await setup(count)
    const measurements: string[] = []
    const rows = await publishNativeSessionMessageBatch({ ...command, measure: async (counter, run) => {
      try { return await run() } finally { measurements.push(counter) }
    } })
    expect(measurements).toEqual(['publication_batch_lease_before', 'publication_batch_sql', 'publication_batch_lease_after'])
    expect(rows).toHaveLength(count)
    const frames = (await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1', [f.workspaceId])).rows
    expect(frames).toHaveLength(1)
    const frameId = frames[0].id
    const edges = (await f.pool.query(`SELECT d.resource_kind,d.resource_id,e.source_kind,e.source_id,e.source_version
      FROM scope_derivations d JOIN scope_derivation_sources e ON e.workspace_id=d.workspace_id AND e.derivation_id=d.id
      WHERE d.workspace_id=$1`, [f.workspaceId])).rows
    for (const row of rows) expect(edges.filter(edge => edge.resource_kind === 'session_message' && edge.resource_id === row.id))
      .toEqual([{ resource_kind: 'session_message', resource_id: row.id, source_kind: 'session_context_revision', source_id: frameId, source_version: '1' }])
    const declarations = edges.filter(edge => edge.resource_kind === 'session_context_revision' && edge.resource_id === frameId)
    for (const source of sources) expect(declarations).toContainEqual(expect.objectContaining({ source_kind: source.resourceKind, source_id: source.resourceId, source_version: source.version }))
    for (const table of ['native_turn_publication_work', 'native_turn_publication_events', 'native_turn_publication_seals', 'native_turn_publication_debt']) {
      expect((await f.pool.query(`SELECT count(*)::int count FROM ${table}`)).rows[0].count).toBe(0)
    }
    expect((await f.pool.query('SELECT content FROM session_messages WHERE id=ANY($1::uuid[])', [rows.map(row => row.id)])).rows).toHaveLength(count)
  })
  it.each(['application_field_derivation_dependencies', 'ALL'])('honors a named %s flush after publication', async constraint => {
    const { f, command, sources, authority } = await setup()
    const rows = await withSessionMessagePublication(authority, sources, async db => {
      const rows = await publishNativeSessionMessageBatch(command, db)
      await db.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`)
      return rows
    })
    expect(rows).toHaveLength(3)
    expect((await f.pool.query('SELECT count(*)::int count FROM native_turn_frames WHERE workspace_id=$1', [f.workspaceId])).rows[0].count).toBe(1)
  })
  it('falls back before payload writes when constraints are already immediate', async () => {
    const { f, command, sources, authority } = await setup()
    const rows = await withSessionMessagePublication(authority, sources, async db => {
      await db.query('SET CONSTRAINTS ALL IMMEDIATE')
      return publishNativeSessionMessageBatch(command, db)
    })
    expect(rows).toHaveLength(3)
    expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([])
  })
  it('keeps frame metadata and construction helpers inaccessible to the application role', async () => {
    const { f } = await setup()
    for (const table of ['native_turn_frames', 'native_turn_publication_work', 'native_turn_publication_events', 'native_turn_publication_seals', 'native_turn_publication_debt']) {
      expect((await f.pool.query('SELECT has_table_privilege($1,$2,$3) allowed', ['app_user', table, 'SELECT,INSERT,UPDATE,DELETE'])).rows[0].allowed).toBe(false)
    }
    expect((await f.pool.query("SELECT has_function_privilege('app_user','publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','EXECUTE') allowed")).rows[0].allowed).toBe(false)
  })
  it.each(['hold', 'body', 'frame-hold'] as const)('rolls the frame and all outputs back after an actual %s mutation during writing', async change => {
    const { f, command, firstMessageId } = await setup()
    const name = `turn_publication_${randomUUID().replaceAll('-', '')}`
    const before = (await f.pool.query('SELECT content,scope_held FROM session_messages WHERE id=$1', [firstMessageId])).rows[0]
    const mutation = change === 'hold' ? `UPDATE session_messages SET scope_held=true WHERE id='${firstMessageId}'::uuid;`
      : change === 'body' ? `UPDATE session_messages SET content='"Fictional changed source"'::jsonb WHERE id='${firstMessageId}'::uuid;`
      : `UPDATE session_context_scope_revisions SET scope_held=true WHERE workspace_id='${f.workspaceId}'::uuid AND parent_kind='turn_frame';`
    await f.pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
      BEGIN ${mutation} RETURN NEW;END $fixture$`)
    try {
      await f.pool.query(`CREATE TRIGGER ${name} AFTER INSERT ON session_messages FOR EACH ROW WHEN (NEW.session_id='${f.session.id}'::uuid) EXECUTE FUNCTION ${name}()`)
      const measurements: string[] = []
      await expect(publishNativeSessionMessageBatch({ ...command, measure: async (counter, run) => {
        try { return await run() } finally { measurements.push(counter) }
      } })).rejects.toThrow()
      expect(measurements).toContain('publication_batch_sql')
      expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([])
      expect((await f.pool.query('SELECT count(*)::int count FROM session_messages WHERE session_id=$1', [f.session.id])).rows[0].count).toBe(3)
      expect((await f.pool.query('SELECT content,scope_held FROM session_messages WHERE id=$1', [firstMessageId])).rows[0]).toEqual(before)
    } finally {
      await f.pool.query(`DROP TRIGGER IF EXISTS ${name} ON session_messages; DROP FUNCTION ${name}()`)
    }
  })
  it.each(['completion', 'debt', 'seal'] as const)('refuses commit when the mandatory %s is removed after writing', async missing => {
    const { f, command, sources, authority } = await setup()
    const name = `turn_publication_${randomUUID().replaceAll('-', '')}`
    const mutation = missing === 'completion' ? 'DROP TRIGGER application_field_derivation_dependencies ON native_turn_publication_seals;'
      : `DELETE FROM native_turn_publication_${missing === 'debt' ? 'debt' : 'seals'} WHERE transaction_id=txid_current();`
    await f.pool.query(`CREATE FUNCTION ${name}() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$ BEGIN ${mutation} END $fixture$`)
    try {
      await expect(withSessionMessagePublication(authority, sources, async db => {
        await publishNativeSessionMessageBatch(command, db)
        await db.query(`SELECT ${name}()`)
        await db.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')
      })).rejects.toThrow()
      expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([])
      expect((await f.pool.query('SELECT count(*)::int count FROM session_messages WHERE session_id=$1', [f.session.id])).rows[0].count).toBe(3)
    } finally { await f.pool.query(`DROP FUNCTION ${name}()`) }
  })
  it('performs two native proofs for a complete batch, including the fresh deferred proof', async () => {
    const { f, command, sources, authority } = await setup(7)
    const name = `turn_publication_${randomUUID().replaceAll('-', '')}`
    await f.pool.query(`CREATE FUNCTION ${name}(enable boolean) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
      BEGIN IF enable THEN PERFORM set_config('track_functions','all',true);END IF;
      RETURN coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid='read_native_turn_compact_requirements(uuid,jsonb,jsonb)'::regprocedure),0);END $fixture$`)
    try {
      await withSessionMessagePublication(authority, sources, async db => {
        const before = Number((await db.query(`SELECT ${name}(true) count`)).rows[0].count)
        await publishNativeSessionMessageBatch(command, db)
        await db.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')
        const after = Number((await db.query(`SELECT ${name}(false) count`)).rows[0].count)
        expect(after - before).toBe(2)
      })
    } finally { await f.pool.query(`DROP FUNCTION ${name}(boolean)`) }
  })
  it('keeps all predecessor helper guards intact', async () => {
    const { f } = await setup()
    for (const name of ['application_native_worklist_helpers_current', 'application_memory_statement_helpers_current',
      'application_native_dependency_batch_helpers_current', 'application_native_covered_queue_current',
      'application_native_covered_evidence_helpers_current', 'application_native_file_capture_helpers_current',
      'application_native_transcript_prepare_helpers_current', 'application_native_field_reference_helpers_current', 'native_turn_helpers_current']) {
      expect((await f.pool.query(`SELECT ${name}() current`)).rows[0].current, name).toBe(true)
    }
  })

  it('consumes old history and newly framed replies through the same typed dependency reader', async () => {
    const { f, command } = await setup()
    await publishNativeSessionMessageBatch(command)
    const authority = await f.modelContext(f.firstId)
    const input = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: 6, authority })
    expect(input.history).toHaveLength(6)
    await publishNativeSessionMessageBatch({ ...command, authority,
      derivation: { ...command.derivation, sources: boundScopeSources(input) } })
    expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1', [f.workspaceId])).rows).toHaveLength(2)
  })
  it('rejects a post-write grant on a private construction column', async () => {
    const { f, command, sources, authority } = await setup()
    const name = `turn_publication_${randomUUID().replaceAll('-', '')}`
    await f.pool.query(`CREATE FUNCTION ${name}() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
      BEGIN GRANT UPDATE(prepared) ON native_turn_publication_work TO app_user;END $fixture$`)
    try {
      await expect(withSessionMessagePublication(authority, sources, async db => {
        await publishNativeSessionMessageBatch(command, db)
        await db.query(`SELECT ${name}()`)
      })).rejects.toThrow()
      expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([])
    } finally { await f.pool.query(`DROP FUNCTION ${name}()`) }
  })

  it.each(['completion', 'contract'] as const)('rejects a replaced %s executable after the writer returns', async changed => {
    const { f, command, sources, authority } = await setup()
    const name = `turn_publication_${randomUUID().replaceAll('-', '')}`
    const replacement = changed === 'completion' ? `CREATE OR REPLACE FUNCTION native_turn_complete_publication() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $replacement$
      BEGIN DELETE FROM native_turn_publication_debt WHERE transaction_id=txid_current();
       DELETE FROM native_turn_publication_work WHERE transaction_id=txid_current();RETURN NULL;END $replacement$`
      : `CREATE OR REPLACE FUNCTION native_turn_publication_contract() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
       SET search_path=pg_catalog,public,pg_temp AS $replacement$ SELECT true $replacement$`
    await f.pool.query(`CREATE FUNCTION ${name}() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
      BEGIN EXECUTE $attack$${replacement}$attack$;END $fixture$`)
    try {
      await expect(withSessionMessagePublication(authority, sources, async db => {
        await publishNativeSessionMessageBatch(command, db)
        await db.query(`SELECT ${name}()`)
        await db.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')
      })).rejects.toThrow()
      expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([])
    } finally { await f.pool.query(`DROP FUNCTION ${name}()`) }
  })

  it('rejects completion replacement after the last source callback', async () => {
    const { f, command } = await setup()
    const name = `zz_turn_publication_${randomUUID().replaceAll('-', '')}`
    await f.pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
      BEGIN IF NEW.source_kind='session_context_revision' AND EXISTS(SELECT 1 FROM scope_derivations d JOIN session_messages m ON m.id=d.resource_id
        WHERE d.id=NEW.derivation_id AND d.workspace_id='${f.workspaceId}'::uuid AND d.resource_kind='session_message'
         AND m.sequence_num=(SELECT max(sequence_num) FROM session_messages WHERE session_id='${f.session.id}'::uuid)) THEN
       EXECUTE $attack$CREATE OR REPLACE FUNCTION native_turn_complete_publication() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
        SET search_path=pg_catalog,public,pg_temp AS $replacement$ BEGIN
         UPDATE native_turn_publication_work SET completion_ready=true WHERE transaction_id=txid_current();
         DELETE FROM native_turn_publication_debt WHERE transaction_id=txid_current();RETURN NULL;END $replacement$$attack$;
      END IF;RETURN NULL;END $fixture$`)
    try {
      await f.pool.query(`CREATE CONSTRAINT TRIGGER ${name} AFTER INSERT ON scope_derivation_sources DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION ${name}()`)
      await expect(publishNativeSessionMessageBatch(command)).rejects.toThrow()
      expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([])
      expect((await f.pool.query('SELECT count(*)::int count FROM session_messages WHERE session_id=$1', [f.session.id])).rows[0].count).toBe(3)
    } finally { await f.pool.query(`DROP TRIGGER ${name} ON scope_derivation_sources; DROP FUNCTION ${name}()`) }
  })
  it('discards rolled-back construction work before a second publication', async () => {
    const { f, command, sources, authority } = await setup()
    await withSessionMessagePublication(authority, sources, async db => {
      await db.query('SAVEPOINT discarded_frame')
      await publishNativeSessionMessageBatch(command, db)
      await db.query('ROLLBACK TO SAVEPOINT discarded_frame')
      await publishNativeSessionMessageBatch(command, db)
    })
    expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1', [f.workspaceId])).rows).toHaveLength(1)
    expect((await f.pool.query('SELECT count(*)::int count FROM session_messages WHERE session_id=$1', [f.session.id])).rows[0].count).toBe(6)
  })
  it('rejects changed database authority context before completion', async () => {
    const { f, command, sources, authority } = await setup()
    await expect(withSessionMessagePublication(authority, sources, async db => {
      await publishNativeSessionMessageBatch(command, db)
      await db.query("SELECT set_config('app.current_user_id',$1,true)", [f.secondId])
    })).rejects.toThrow()
    expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([])
  })

  it.each(['table', 'function', 'column'] as const)('rejects unexpected inherited private %s grants before enrollment', async kind => {
    const { f } = await setup()
    const sql = await readFile(new URL('../../../migrations/8188_native_turn_shared_publication.sql', import.meta.url), 'utf8')
    const name = `turn_acl_${randomUUID().replaceAll('-', '')}`, probe = `turn_probe_${randomUUID().replaceAll('-', '')}`
    const owner = await f.pool.connect()
    try {
      await owner.query('BEGIN')
      await owner.query(`CREATE ROLE ${name}`)
      if (kind === 'function') {
        await owner.query(`ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO ${name}`)
        await owner.query(`CREATE FUNCTION ${probe}() RETURNS boolean LANGUAGE sql AS 'SELECT true'`)
        const sweep = sql.match(/DO \$private\$[\s\S]*?END \$private\$;/)![0].replace("'native_turn_frame_payload_shape'", `'${probe}'`)
        await expect(owner.query(sweep)).rejects.toThrow(/native_turn_publication_private_function_acl/)
      } else {
        if (kind === 'table') await owner.query(`ALTER DEFAULT PRIVILEGES GRANT SELECT,INSERT,UPDATE ON TABLES TO ${name}`)
        await owner.query(`CREATE TABLE ${probe}(value text)`)
        if (kind === 'column') await owner.query(`GRANT UPDATE(value) ON ${probe} TO ${name}`)
        const sweep = sql.match(/DO \$private_tables\$[\s\S]*?END \$private_tables\$;/)![0].replace("'native_turn_frames'::regclass", `'${probe}'::regclass`)
        await expect(owner.query(sweep)).rejects.toThrow(/native_turn_publication_private_table_acl/)
      }
    } finally { await owner.query('ROLLBACK'); owner.release() }
  })

  it('refuses a cleanup rewrite rule introduced after publication', async () => {
    const { f, command, sources, authority } = await setup()
    const name = `turn_rule_${randomUUID().replaceAll('-', '')}`
    await f.pool.query(`CREATE FUNCTION ${name}() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
      BEGIN EXECUTE $rule$CREATE RULE ${name} AS ON DELETE TO native_turn_publication_work DO ALSO
       UPDATE session_messages SET scope_held=true WHERE workspace_id='${f.workspaceId}'::uuid$rule$;END $fixture$`)
    try {
      await expect(withSessionMessagePublication(authority, sources, async db => {
        await publishNativeSessionMessageBatch(command, db)
        await db.query(`SELECT ${name}()`)
      })).rejects.toThrow()
      expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([])
      expect((await f.pool.query('SELECT id FROM session_messages WHERE workspace_id=$1 AND scope_held', [f.workspaceId])).rows).toEqual([])
    } finally { await f.pool.query(`DROP FUNCTION ${name}()`) }
  })

})
