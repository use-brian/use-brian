/** [COMP:api/native-chat-read-cost] Actual capacity SQL with controlled admission inputs.
 * These tests prove capacity and pre-write behavior, not source authorization.
 * Real admission, final-graph and Calendar acceptance use the PG18 journey. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const migration = await readFile(new URL('../../migrations/8260_native_query_capture_reservation.sql', import.meta.url), 'utf8')
const predecessor = await readFile(new URL('../../migrations/8183_native_turn_requirements.sql', import.meta.url), 'utf8')
const fragment = (name: string) => migration.split(`$${name}$`)[1]
const privacyReader = predecessor.slice(predecessor.indexOf('CREATE OR REPLACE FUNCTION public.native_turn_privacy_edges('),
  predecessor.indexOf('CREATE OR REPLACE FUNCTION public.native_turn_metadata_acquire('))
const workspace = randomUUID(), session = randomUUID(), native = { kind: 'native', moduleKey: 'native' }
const sourceNode = (kind: string, id: string, version = '1') => ({ tag: 'source', kind, id, version })
const point = (id: string) => ({ tag: 'point', kind: 'session_message', id, fields: ['content'] })
const edge = (parent: unknown, child: unknown, edge_kind = 'derivation') => ({ parent, child, edge_kind })
type Field = ReturnType<typeof field>
function field(id = randomUUID(), body = randomUUID(), version = 'v1') {
  return { resourceId: id, id: body, origin: native, typeKey: 'session_message', selection: 'query', selectedVersion: null,
    fields: ['content'], source: { resourceKind: 'application_field', resourceId: id, version },
    state: { sourceKind: 'session_message', sourceId: body, sourceVersion: '1' }, sources: [] as Array<Record<string, string>> }
}
function domain(children: Field[], through: number, type = 'session_message') {
  const domainId = randomUUID(), envelope = { ...field(randomUUID(), domainId), typeKey: type, selection: 'query_domain',
    state: { sourceKind: 'application_query_domain', sourceId: domainId, sourceVersion: 'domain-v1' },
    sources: children.map(child => child.source), children }
  return { type, domainId, domainIdentity: 'domain-v1', domain: { sessionId: session, throughSequence: through, fields: ['content'] }, envelope }
}
let db: PGlite

beforeEach(async () => {
  db = new PGlite()
  await db.exec(`CREATE TABLE session_messages(workspace_id uuid,session_id uuid,id uuid,sequence_num integer);
    CREATE TABLE scope_derivations(workspace_id uuid,id uuid,resource_kind text,resource_id uuid);
    CREATE TABLE scope_derivation_sources(workspace_id uuid,derivation_id uuid,source_kind text,source_id uuid);
    CREATE TABLE application_field_resources(workspace_id uuid,id uuid,origin jsonb,type_key text,resource_id uuid);
    CREATE TABLE application_field_observations(workspace_id uuid,resource_id uuid,version text,source_kind text,source_id uuid);
    CREATE TABLE application_field_observation_sources(workspace_id uuid,resource_id uuid,version text,source_kind text,source_id uuid);
    CREATE TABLE fixture_state(metadata jsonb);
    CREATE TABLE fixture_writes(id integer);
    CREATE FUNCTION native_turn_context() RETURNS jsonb LANGUAGE sql AS $$SELECT '{"fixture":true}'::jsonb$$;
    CREATE FUNCTION native_turn_helpers_current() RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
    CREATE FUNCTION native_turn_compact_metadata(uuid,jsonb,jsonb) RETURNS jsonb LANGUAGE sql AS $$SELECT metadata FROM fixture_state$$;
    ${privacyReader}
    CREATE FUNCTION fixture_reserve(w uuid,initial jsonb,all_captures jsonb) RETURNS jsonb LANGUAGE plpgsql AS $body$
    DECLARE roots jsonb:='[]';selectors jsonb:='[]';context jsonb:=native_turn_context();
      ${fragment('reservation_declaration')}
    BEGIN
      ${fragment('reservation_branch')}
      INSERT INTO fixture_writes VALUES(1);
      RETURN jsonb_build_object('semanticNodes',jsonb_array_length(reservation_semantic_nodes),
        'semanticEdges',jsonb_array_length(reservation_semantic_edges),'privacyNodes',jsonb_array_length(reservation_privacy_nodes),
        'privacyEdges',jsonb_array_length(reservation_privacy_edges),'points',
        (SELECT coalesce(jsonb_agg(n->'id'),'[]') FROM jsonb_array_elements(reservation_semantic_nodes) n WHERE n->>'tag'='point'));
    END $body$;`)
})
afterEach(async () => { await db?.close() })

async function reserve(captures: ReturnType<typeof domain>[], fields: Field[], options: {
  nodes?: unknown[]; edges?: unknown[]; privacyNodes?: unknown[]; privacyEdges?: number; corrupt?: (meta: any) => void
} = {}) {
  const nodes = options.nodes ?? [], edges = options.edges ?? [], privacyNodes = options.privacyNodes ?? []
  const counts = { semanticNodes: nodes.length, semanticEdges: edges.length, privacyNodes: privacyNodes.length, privacyEdges: options.privacyEdges ?? 0 }
  const requirements = { nativeMetadata: [], sessionParents: [] }
  const metadata = { eligibleMetadata: true, counts, witness: { ...requirements, nodes, edges, privacyNodes } }
  const initial = { counts: { ...counts }, requirements, queryCaptures: captures, validUntil: 'infinity' }
  options.corrupt?.(metadata)
  await db.query('DELETE FROM fixture_state')
  await db.query('INSERT INTO fixture_state VALUES($1)', [metadata])
  const all = [...captures.map(capture => capture.envelope), ...fields]
  return (await db.query<{ value: any }>('SELECT fixture_reserve($1,$2,$3) AS value', [workspace, initial, all])).rows[0].value
}
async function writes() { return (await db.query<{ count: number }>('SELECT count(*)::integer count FROM fixture_writes')).rows[0].count }
async function messages(ids: string[]) {
  for (let n = 0; n < ids.length; n++) await db.query('INSERT INTO session_messages VALUES($1,$2,$3,$4)', [workspace, session, ids[n], n + 1])
}
function dag(size: number, edgeCount: number) {
  const nodes = Array.from({ length: size }, () => sourceNode('session_message', randomUUID()))
  const edges = []
  for (let parent = 1; parent < nodes.length && edges.length < edgeCount; parent++) {
    for (let child = 0; child < parent && edges.length < edgeCount; child++) edges.push(edge(nodes[parent], nodes[child]))
  }
  return { nodes, edges }
}

describe.sequential('[COMP:api/native-chat-read-cost] staged query capture capacity', () => {
  it('admits reused captures that exceed the former per-capture estimate while keeping the real edge limit', async () => {
    const fields = Array.from({ length: 280 }, () => field())
    await messages(fields.map(value => value.id))
    const nodes = fields.flatMap(value => [sourceNode('application_field', value.resourceId, 'v1'), sourceNode('session_message', value.id), point(value.id)])
    const edges = fields.flatMap(value => [edge(sourceNode('application_field', value.resourceId, 'v1'), sourceNode('session_message', value.id), 'observation'),
      edge(sourceNode('application_field', value.resourceId, 'v1'), point(value.id), 'field_point')])
    const extra = dag(160, 12034 - edges.length)
    nodes.push(...extra.nodes)
    edges.push(...extra.edges)
    const captures = [domain(fields, 280), domain([], 280, 'session_message_annotation')]
    expect(edges.length + 16 * (fields.length + captures.length)).toBeGreaterThan(16384)
    const result = await reserve(captures, fields, { nodes, edges })
    expect(result).not.toBeNull()
    expect(result.semanticEdges).toBeLessThanOrEqual(16384)
    expect(result.semanticNodes).toBeLessThanOrEqual(4096)
    expect(await writes()).toBe(1)
  })

  it('reserves every physical domain candidate, including filtered rows and excluding rows beyond the bound', async () => {
    const ids = Array.from({ length: 4 }, () => randomUUID())
    await messages(ids)
    const selected = field(randomUUID(), ids[0])
    const result = await reserve([domain([selected], 3)], [selected])
    expect(result.points.sort()).toEqual(ids.slice(0, 3).sort())
  })

  it('keeps semantic versions distinct while deduplicating versionless privacy and repeated captures', async () => {
    const first = field(), second = { ...first, source: { ...first.source, version: 'v2' } }
    const result = await reserve([], [first, second, first])
    expect(result).toMatchObject({ semanticNodes: 4, semanticEdges: 4, privacyNodes: 2, privacyEdges: 1 })
  })

  it('retains older observation ancestry of reused field resources outside the initial graph', async () => {
    const selected = field(), old = randomUUID(), deeper = randomUUID(), derivation = randomUUID()
    await db.query('INSERT INTO application_field_observations VALUES($1,$2,$3,$4,$5)', [workspace, selected.resourceId, 'old', 'external_source', old])
    await db.query('INSERT INTO scope_derivations VALUES($1,$2,$3,$4)', [workspace, derivation, 'external_source', old])
    await db.query('INSERT INTO scope_derivation_sources VALUES($1,$2,$3,$4)', [workspace, derivation, 'session_context_revision', deeper])
    expect(await reserve([], [selected])).toMatchObject({ privacyNodes: 4, privacyEdges: 3 })
  })

  it('refuses a genuinely oversized semantic graph before reaching any immutable write', async () => {
    const graph = dag(190, 16384)
    expect(await reserve([], [field()], graph)).toBeNull()
    expect(await writes()).toBe(0)
  })

  it('refuses a genuinely oversized privacy frontier before reaching any immutable write', async () => {
    const selected = field(), derivation = randomUUID()
    await db.query('INSERT INTO scope_derivations VALUES($1,$2,$3,$4)', [workspace, derivation, 'session_message', selected.id])
    await db.query(`INSERT INTO scope_derivation_sources
      SELECT $1::uuid,$2::uuid,'session_context_revision',gen_random_uuid() FROM generate_series(1,4097)`, [workspace, derivation])
    expect(await reserve([], [selected])).toBeNull()
    expect(await writes()).toBe(0)
  })

  it.each(['missing_graph', 'wrong_count', 'changed_parent'])(
    'never interprets an incomplete or changed metadata graph as an empty reservation: %s', async (mode) => {
      expect(await reserve([], [field()], { corrupt: meta => {
        if (mode === 'missing_graph') delete meta.witness.edges
        if (mode === 'wrong_count') meta.counts.semanticEdges = 1
        if (mode === 'changed_parent') meta.witness.sessionParents = [{ changed: true }]
      } })).toBeNull()
      expect(await writes()).toBe(0)
    })
})
