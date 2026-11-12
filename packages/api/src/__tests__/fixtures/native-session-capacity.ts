/** [COMP:api/native-chat-read-cost] Canonical capacity oracle for retained topic upgrades. */
import { randomUUID } from 'node:crypto'
import type { SessionContextAuthority } from '@use-brian/core'
import { expect } from 'vitest'
import { query } from '../../db/client.js'
import { withSessionMessagePublication } from '../../db/session-context-revisions.js'

type Counts = { semanticNodes: number; semanticEdges: number; privacyNodes: number; privacyEdges: number }
type Capacity = { admitted: boolean; available: boolean; initialCounts: Counts; finalCounts: Counts; reservedCounts: Counts;
  allCaptures: number; oldSemanticEstimate: number; sourceCount: number }

/** Replace only the result projection, never admission or reservation, in a
 * disposable copy of the installed reader. Its complete canonical materialize /
 * fresh-proof path executes as app_user and rolls back before returning. */
export async function assertRetainedNativeQueryCapacity(authority: SessionContextAuthority,
  expectedStatementTimeout: '15s' | '1min' = '15s'): Promise<Capacity> {
  const { execution } = authority
  const workspace = execution.security.access.workspaceId, session = execution.lifecycle.sessionId
  const signature = 'read_native_turn_session_query(uuid,uuid,integer,integer)'
  const original = (await query<{ body: string; definition: string; ownerSql: string }>(`
    SELECT prosrc body,pg_get_functiondef(oid) definition,quote_ident(pg_get_userbyid(proowner)) "ownerSql"
    FROM pg_proc WHERE oid=$1::regprocedure`, [signature])).rows[0]
  const projection = " RETURN jsonb_build_object('history',history,'annotations',annotations,\n  'proof',jsonb_build_object('admitted',true,'immutable',fresh->'immutable','current',fresh->'current'));"
  expect(original.body.split(projection)).toHaveLength(2)
  const guard = ` IF w IS DISTINCT FROM '${workspace}'::uuid OR s IS DISTINCT FROM '${session}'::uuid THEN RAISE EXCEPTION 'Fictional capacity boundary' USING ERRCODE='42501';END IF;\n`
  const output = ` RETURN jsonb_build_object('initialCounts',initial->'counts','finalCounts',fresh->'counts',
    'reservedCounts',jsonb_build_object('semanticNodes',jsonb_array_length(reservation_semantic_nodes),
      'semanticEdges',jsonb_array_length(reservation_semantic_edges),'privacyNodes',jsonb_array_length(reservation_privacy_nodes),
      'privacyEdges',jsonb_array_length(reservation_privacy_edges)),
    'allCaptures',jsonb_array_length(all_captures),'oldSemanticEstimate',(initial#>>'{counts,semanticEdges}')::integer+16*jsonb_array_length(all_captures),
    'admitted',fresh->'admitted','available',fresh->'available','sourceCount',jsonb_array_length(sources));`
  const body = original.body.replace(projection, () => output).replace('BEGIN\n', () => `BEGIN\n${guard}`)
  const port = `fixture_capacity_${randomUUID().replaceAll('-', '')}`
  const definition = original.definition.replace('FUNCTION public.read_native_turn_session_query(', `FUNCTION public.${port}(`)
    .replace(original.body, () => body)
  expect(definition).not.toBe(original.definition)
  const tables = ['application_query_domains', 'application_field_resources', 'application_field_observations',
    'application_field_observation_sources', 'session_messages', 'session_context_scope_revisions',
    'session_context_revision_contents', 'scope_derivations', 'scope_derivation_sources', 'native_turn_frames']
  async function snapshot() {
    const state: Record<string, unknown> = {}
    for (const table of tables) state[table] = (await query(`SELECT count(*)::int count,
      md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) digest
      FROM ${table} t WHERE workspace_id=$1`, [workspace])).rows[0]
    return state
  }
  const before = await snapshot()
  const through = (await query<{ through: number }>('SELECT max(sequence_num)::int through FROM session_messages WHERE session_id=$1', [session])).rows[0].through
  try {
    await query(definition)
    await query(`ALTER FUNCTION public.${port}(uuid,uuid,integer,integer) OWNER TO ${original.ownerSql};
      REVOKE ALL ON FUNCTION public.${port}(uuid,uuid,integer,integer) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.${port}(uuid,uuid,integer,integer) TO app_user`)
    const result = await withSessionMessagePublication(authority, [], async client => {
      expect((await client.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0])
        .toEqual({ current_user: 'app_user', rolsuper: false, rolbypassrls: false })
      expect((await client.query("SELECT current_setting('statement_timeout') value")).rows[0].value).toBe(expectedStatementTimeout)
      await client.query('SAVEPOINT capacity_oracle')
      try {
        return (await client.query<{ value: Capacity | null }>(`SELECT public.${port}($1,$2,$3,$3) value`, [workspace, session, through])).rows[0].value
      } finally { await client.query('ROLLBACK TO SAVEPOINT capacity_oracle') }
    })
    expect(result).not.toBeNull()
    expect(result).toMatchObject({ admitted: true, available: true })
    expect(result!.sourceCount).toBeGreaterThan(255)
    for (const key of ['semanticNodes', 'semanticEdges', 'privacyNodes', 'privacyEdges'] as const) {
      expect(result!.reservedCounts[key]).toBeGreaterThanOrEqual(result!.finalCounts[key])
    }
    for (const key of ['semanticNodes', 'privacyNodes'] as const) expect(result!.finalCounts[key]).toBeLessThanOrEqual(4_096)
    for (const key of ['semanticEdges', 'privacyEdges'] as const) expect(result!.finalCounts[key]).toBeLessThanOrEqual(16_384)
    expect(await snapshot()).toEqual(before)
    return result!
  } finally {
    await query(`DROP FUNCTION IF EXISTS public.${port}(uuid,uuid,integer,integer)`)
    expect((await query<{ body: string }>('SELECT prosrc body FROM pg_proc WHERE oid=$1::regprocedure', [signature])).rows[0].body).toBe(original.body)
  }
}
