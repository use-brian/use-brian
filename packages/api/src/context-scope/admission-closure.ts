/** Per-turn admission closure (Decision 10 step one). [COMP:api/turn-admission-closure]
 *
 * An admission has two parts. The closure proof is expensive: which sources the
 * turn depends on (owner-pool lineage discovery, metadata only) and their
 * current admission state for the reading principal (the Page source-family
 * capture, `capture_page_closure_evidence`). The principal comparison is cheap:
 * each consumer's own visibility and label checks against that proof
 * (`checkedEvidenceInput` and `checkedConversationCapture`, caller-evidence.ts).
 *
 * The turn owner (turn/kernel.ts) opens one closure per turn, bound to the
 * turn's invocation lease, and disposes it when the turn finishes. Admissions of
 * that turn reuse what the closure proved while its currency witness is
 * unchanged; each still runs its own principal comparison. A proof is keyed by
 * the principal, the exact transaction context and the exact root set, so no
 * principal inherits another principal's admission: what is shared is the
 * proven source set under one lease.
 *
 * Currency witness: before anything relying on a source is produced, the
 * closure reads that source's current state (canonical snapshot), the lineage
 * of the whole node set and the workspace policy epoch. Every later admission
 * reads them again first; any difference (a hold, a reclassification, a Page
 * moved or its boundary changed, a deletion, an appended lineage edge, a policy
 * or timed transition) discards the whole closure, and that admission and every
 * later one re-prove on the unchanged full path. A witness failure is a change,
 * never a pass.
 *
 * Spec: docs/architecture/engine/turn-kernel.md "Per-turn admission closure";
 * docs/architecture/context-engine/scoped-context.md "Per-turn admission closure".
 */
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { ExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import { resourceScopeKey, type ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import type { CurrentAuthorityBoundary } from '@use-brian/agent-runtime/tools/types.js'
import { getPool } from '../db/client.js'

export type AdmissionClosureStats = Readonly<{
  /** Proofs (and discoveries) the closure ran because nothing current matched. */
  proofs: number
  discoveries: number
  /** Admissions that reused a proven closure or discovery after a passing witness. */
  sharedProofs: number
  /** Proofs derived from a stored proof plus a proof of only the added roots. */
  extendedProofs: number
  sharedDiscoveries: number
  /** Witness reads, and how many saw a change (the closure was discarded). */
  witnesses: number
  discarded: number
}>

type Proof = { kind: 'complete'; evidence: { sources?: ScopeSource[] }; current: ScopeSource[] }
type Witness = { snapshots: Map<string, string>; lineage: string; epoch: string }

const exactNode = (source: Pick<ScopeSource, 'resourceKind' | 'resourceId' | 'version'>) => `${source.resourceKind}:${source.resourceId}:${source.version}`
const labelledNode = (source: ScopeSource) => JSON.stringify([source.resourceKind, source.resourceId, source.version, resourceScopeKey(source)])
const exactKey = (roots: readonly ScopeSource[]) => JSON.stringify(roots.map(source =>
  [source.resourceKind, source.resourceId, source.version, resourceScopeKey(source)]).sort())

class Closure {
  disposed = false
  /** Set by the turn's first Page source-family proof. Until then the closure
   * reads nothing and shares nothing, so a turn that never reaches that
   * family pays no statement for it. */
  active = false
  /** Discards so far; an entry produced in an older epoch is never stored. */
  epoch = 0
  /** Baseline generation; each node remembers when its baseline was read. */
  generation = 0
  readonly nodes = new Map<string, { source: ScopeSource; generation: number }>()
  witness: Witness | undefined
  readonly discoveries = new Map<string, unknown>()
  readonly proofs = new Map<string, Proof>()
  /** For each stored proof: its principal and context, exact roots (with labels) and nodes. */
  readonly proofShapes = new Map<string, { context: string; roots: Set<string>; nodes: Set<string> }>()
  contextSettings: Promise<string[] | null> | undefined
  readonly counters = { proofs: 0, discoveries: 0, sharedProofs: 0, extendedProofs: 0, sharedDiscoveries: 0, witnesses: 0, discarded: 0 }
  constructor(readonly lease: CurrentAuthorityBoundary, readonly execution: ExecutionContext,
    readonly workspaceId: string, readonly actor: string, readonly assistantId: string) {}
  discard(): void {
    this.epoch++; this.nodes.clear(); this.discoveries.clear(); this.proofs.clear(); this.proofShapes.clear(); this.witness = undefined
  }
}

export type TurnAdmissionClosure = Readonly<{ dispose(): void; stats(): AdmissionClosureStats }>

// A binding, not a cache: how an admission holding the turn's lease reaches the
// closure its owner opened. Results live in the owner's closure and end with it.
const bound = new WeakMap<CurrentAuthorityBoundary, Closure>()

/** Open the turn's closure. Owner-only (turn/kernel.ts); one live closure per lease. */
export function openTurnAdmissionClosure(execution: ExecutionContext): TurnAdmissionClosure | undefined {
  const lease = execution.security.authority, access = execution.security.access
  if (!lease || bound.has(lease) || execution.ownership.kind !== 'workspace' || !access.workspaceId || !access.userId) return undefined
  const closure = new Closure(lease, execution, access.workspaceId, access.userId, execution.assistant.id)
  bound.set(lease, closure)
  return Object.freeze({
    dispose() {
      if (closure.disposed) return
      closure.disposed = true
      closure.discard()
      if (bound.get(lease) === closure) bound.delete(lease)
    },
    stats: () => Object.freeze({ ...closure.counters }),
  })
}

/** The settings the capture fingerprints its own context with
 * (`native_turn_context()`), read from the installed function once per turn.
 * The consumer's transaction is keyed by exactly those settings plus its
 * roles, so only an identical context can reuse a proof. Null: no sharing. */
async function contextSettings(closure: Closure): Promise<string[] | null> {
  return closure.contextSettings ??= getPool().query<{ src: string }>(
    "SELECT prosrc AS src FROM pg_proc WHERE oid='public.native_turn_context()'::regprocedure").then(({ rows }) => {
    const names = [...new Set([...(rows[0]?.src ?? '').matchAll(/'(app\.[a-z0-9_]+)'/g)].map(match => match[1]!))].sort()
    return names.length ? names : null
  }, () => null)
}
const PAGE_KINDS = ['page_event_changed', 'page_event_destination', 'page_live_changed', 'page_live_destination']
// Families whose complete current state the witness reads. Anything else
// (recordings, episodes, external sources, entities, Office observations, ...)
// is never shared: its admission always takes the unshared path.
const WITNESSED_KINDS = new Set(['session_message', 'session_context_revision', 'application_field', 'workspace_file', 'memory', ...PAGE_KINDS])
const chunks = <T>(values: readonly T[], size: number) => Array.from({ length: Math.ceil(values.length / size) },
  (_, index) => ({ offset: index * size, part: values.slice(index * size, index * size + size) }))
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Current state of the node set. Owner-pool metadata only: it can withhold
 * reuse, never grant anything. */
async function readWitness(closure: Closure, sources: readonly ScopeSource[]): Promise<Witness> {
  const pool = getPool(), w = closure.workspaceId
  const [snapshots, [lineage, epoch]] = await Promise.all([
    // Each node's current state: the canonical snapshot and review state; for a
    // turn frame (session_context_revision) its row version, hold, review
    // state, recording-privacy admission and content (any write to the frame
    // row changes its version); for a Page receipt its current authority for
    // this principal (saved and current boundaries). Metadata only.
    (async () => {
      // Grouped by family so each statement stays set-based; ordinals index `sources`.
      const groups = [
        { kinds: PAGE_KINDS, sql: `SELECT t.ord::int AS ord,jsonb_build_array(read_page_scope_authority($1,t.kind,t.id,$5)) AS s
          FROM unnest($2::text[],$3::uuid[],$4::int[]) AS t(kind,id,ord)` },
        { kinds: ['application_field'], sql: `SELECT t.ord::int AS ord,jsonb_build_array(scope_review_state_held(t.kind,t.id)) AS s
          FROM unnest($2::text[],$3::uuid[],$4::int[]) AS t(kind,id,ord) WHERE $1::uuid IS NOT NULL` },
        { kinds: ['session_context_revision'], sql: `SELECT t.ord::int AS ord,jsonb_build_array(r.xmin::text,r.scope_held,scope_review_state_held(t.kind,t.id),
            recording_source_read_allowed($1,t.kind,t.id),EXISTS(SELECT 1 FROM session_context_revision_contents c WHERE c.workspace_id=$1 AND c.revision_id=t.id)) AS s
          FROM unnest($2::text[],$3::uuid[],$4::int[]) AS t(kind,id,ord)
          LEFT JOIN session_context_scope_revisions r ON r.workspace_id=$1 AND r.id=t.id` },
        { kinds: ['session_message'], sql: `SELECT t.ord::int AS ord,jsonb_build_array(m.xmin::text,m.scope_held,m.scope_version,scope_review_state_held(t.kind,t.id),
            recording_source_read_allowed($1,t.kind,t.id)) AS s
          FROM unnest($2::text[],$3::uuid[],$4::int[]) AS t(kind,id,ord)
          LEFT JOIN session_messages m ON m.workspace_id=$1 AND m.id=t.id` },
        { kinds: null, sql: `SELECT t.ord::int AS ord,jsonb_build_array(read_scope_source($1,t.kind,t.id),scope_review_state_held(t.kind,t.id)) AS s
          FROM unnest($2::text[],$3::uuid[],$4::int[]) AS t(kind,id,ord)` },
      ]
      const rows: Array<{ ord: number; s: unknown }> = []
      const claimed = new Set(groups.flatMap(group => group.kinds ?? []))
      for (const group of groups) {
        const members = sources.map((source, index) => ({ source, ord: index + 1 }))
          .filter(({ source }) => group.kinds ? group.kinds.includes(source.resourceKind) : !claimed.has(source.resourceKind))
        if (!members.length) continue
        rows.push(...(await pool.query<{ ord: number; s: unknown }>(group.sql, [w, members.map(({ source }) => source.resourceKind),
          members.map(({ source }) => source.resourceId), members.map(({ ord }) => ord), ...(group.kinds === PAGE_KINDS ? [closure.actor] : [])])).rows)
      }
      return { rows }
    })(),
    (async () => {
      // One statement: the lineage reader takes at most 100 roots per call.
      const parts = chunks(sources, 100)
      const { rows } = await pool.query<{ kind: string; id: string; version: string; e: unknown }>(`SELECT l.kind,l.id,l.version,NULL::jsonb AS e
          FROM unnest($2::int[]) AS c(n) CROSS JOIN LATERAL application_scope_lineage($1,ARRAY(SELECT jsonb_array_elements_text(($3::jsonb->(c.n))->'k')),
            ARRAY(SELECT jsonb_array_elements_text(($3::jsonb->(c.n))->'i'))::uuid[],ARRAY(SELECT jsonb_array_elements_text(($3::jsonb->(c.n))->'v'))) l
        UNION ALL SELECT NULL,NULL,NULL,read_application_policy_epoch($1,$4,$5)`,
        [w, parts.map((_, index) => index), JSON.stringify(parts.map(({ part }) => ({ k: part.map(source => source.resourceKind),
          i: part.map(source => source.resourceId), v: part.map(source => source.version) }))), closure.actor, closure.assistantId])
      const nodes = rows.filter(row => row.kind !== null).map(row => `${row.kind}:${row.id}:${row.version}`)
      const policy = rows.find(row => row.kind === null)?.e
      return [digest([...new Set(nodes)].sort()), policy] as const
    })(),
  ])
  if (snapshots.rows.length !== sources.length) throw new Error('Admission closure witness unavailable')
  const map = new Map<string, string>()
  for (const row of snapshots.rows) {
    const source = sources[row.ord - 1]
    if (!source) throw new Error('Admission closure witness unavailable')
    map.set(exactNode(source), JSON.stringify(row.s))
  }
  if (epoch === null || epoch === undefined) throw new Error('Admission closure witness unavailable')
  return { snapshots: map, lineage, epoch: digest(epoch) }
}

function sameSnapshots(now: Witness, before: Witness, keys: Iterable<string>): boolean {
  for (const key of keys) if (now.snapshots.get(key) !== before.snapshots.get(key)) return false
  return now.epoch === before.epoch
}

/** One admission's view of its turn's closure: one witness read, then reuse or prove. */
export type ClosureAdmission = Readonly<{
  /** Read the witness now (it is otherwise read at first use). A locked view
   * must be readied before its transaction takes locks. */
  ready(): Promise<void>
  /** Owner-pool metadata discovery of `roots`. `nodes` names what a result
   * relies on, or null when it is not pure metadata (it is then never shared). */
  discover<T>(consumer: string, roots: readonly ScopeSource[], run: () => Promise<T>,
    nodes: (value: T) => readonly ScopeSource[] | null): Promise<T>
  /** The Page source-family proof of `roots` for `actor` on the consumer's own
   * transaction. The caller still compares its own principal against the result. */
  pageClosure<T extends Proof>(client: Pick<PoolClient, 'query'>, roots: readonly ScopeSource[], actor: string,
    prove: (roots: readonly ScopeSource[]) => Promise<T | null>): Promise<T | null>
}>

/** The closure of the turn whose lease `execution` holds, for one admission; undefined outside an owned turn. */
export function beginClosureAdmission(execution: ExecutionContext | undefined,
  options: {
    /** The consumer's transaction holds row locks (publication): the view never
     * reads the owner pool after `ready()`, so a miss proves without storing. */
    locked?: boolean
  } = {}): ClosureAdmission | undefined {
  const lease = execution?.security.authority
  const closure = lease ? bound.get(lease) : undefined
  if (!closure || closure.disposed || closure.execution !== execution || closure.lease !== execution?.security.authority) return undefined
  let checked: Promise<void> | undefined
  const current = () => checked ??= (async () => {
    if (closure.disposed || !closure.witness || !closure.nodes.size) return
    closure.counters.witnesses++
    let now: Witness | undefined
    const epoch = closure.epoch, generation = closure.generation, keys = [...closure.nodes.keys()]
    try { now = await readWitness(closure, [...closure.nodes.values()].map(node => node.source)) } catch { now = undefined }
    // Discarded meanwhile by another admission: nothing left to compare.
    if (closure.epoch !== epoch || !closure.witness) return
    // Compare the nodes this read covered. A concurrent extension re-read and
    // compared their lineage after this read began, so lineage is compared
    // only when the node set did not move meanwhile.
    if (!now || closure.generation === generation && now.lineage !== closure.witness.lineage || !sameSnapshots(now, closure.witness, keys)) {
      closure.counters.discarded++
      closure.discard()
    }
  })()
  /** Give every source a baseline read now, before anything relying on it is produced. */
  const extend = async (sources: readonly ScopeSource[]): Promise<boolean> => {
    const missing = [...new Map(sources.filter(source => !closure.nodes.has(exactNode(source))).map(source => [exactNode(source), source])).values()]
    if (!missing.length) return true
    const epoch = closure.epoch, generation = closure.generation, before = closure.witness
    const old = [...closure.nodes.values()].map(node => node.source), oldKeys = [...closure.nodes.keys()]
    const now = await readWitness(closure, [...old, ...missing])
    // A concurrent extension moved the baseline: this one stores nothing.
    if (closure.epoch !== epoch || closure.generation !== generation || closure.disposed) return false
    if (before) {
      // The old nodes must still be as witnessed: their snapshots, and their
      // lineage read after this baseline (an append in between is a change).
      const lineage = old.length ? (await readWitness(closure, old)).lineage : before.lineage
      if (closure.epoch !== epoch || closure.generation !== generation || closure.disposed) return false
      if (lineage !== before.lineage || !sameSnapshots(now, before, oldKeys)) {
        closure.counters.discarded++
        closure.discard()
        return false
      }
    }
    closure.generation++
    for (const source of missing) closure.nodes.set(exactNode(source), { source: structuredClone(source), generation: closure.generation })
    closure.witness = now
    return true
  }
  /** Store only a result reproduced after every node it relies on had its baseline. */
  const covered = (sources: readonly ScopeSource[], generation: number) => sources.every(source => {
    const node = closure.nodes.get(exactNode(source))
    return node !== undefined && node.generation <= generation
  })
  const produce = async <T>(store: Map<string, unknown>, key: string, roots: readonly ScopeSource[], run: () => Promise<T>,
    nodes: (value: T) => readonly ScopeSource[] | null): Promise<T> => {
    const epoch = closure.epoch
    if (roots.some(source => !WITNESSED_KINDS.has(source.resourceKind))
      || !await extend(roots).catch(() => false) || closure.epoch !== epoch) return run()
    const generation = closure.generation
    const value = await run()
    const relied = nodes(value)
    if (!relied || closure.disposed || closure.epoch !== epoch
      || relied.some(source => !WITNESSED_KINDS.has(source.resourceKind))) return value
    if (!covered(relied, generation)) {
      // It reached sources without a baseline older than this result: give
      // them one now and store nothing. The next admission asking the same
      // question produces it again with every source covered, and stores it.
      await extend(relied).catch(() => false)
      return value
    }
    if (!closure.disposed && closure.epoch === epoch) store.set(key, structuredClone(value))
    return value
  }
  return Object.freeze({
    async discover<T>(consumer: string, roots: readonly ScopeSource[], run: () => Promise<T>, nodes: (value: T) => readonly ScopeSource[] | null) {
      if (!closure.active) return run()
      await current()
      const key = digest([consumer, exactKey(roots)]), hit = closure.discoveries.get(key)
      if (hit !== undefined && !closure.disposed) { closure.counters.sharedDiscoveries++; return structuredClone(hit) as T }
      if (closure.disposed) return run()
      closure.counters.discoveries++
      return produce(closure.discoveries, key, roots, run, nodes)
    },
    ready: () => closure.active ? current() : Promise.resolve(),
    async pageClosure<T extends Proof>(client: Pick<PoolClient, 'query'>, roots: readonly ScopeSource[], actor: string,
      prove: (roots: readonly ScopeSource[]) => Promise<T | null>) {
      const full = () => prove(roots)
      if (closure.disposed || actor !== closure.actor || options.locked && !checked) return full()
      closure.active = true
      // The proof depends on the transaction's principal and settings: key it
      // by the capture's own context fingerprint, read on this transaction.
      const settings = await contextSettings(closure)
      if (!settings) return full()
      const context = (await client.query<{ c: unknown }>(`SELECT jsonb_build_object('sessionUser',session_user,'currentUser',current_user,
        'settings',(SELECT jsonb_object_agg(k,current_setting(k,true)) FROM unnest($1::text[]) k)) AS c`, [settings])).rows[0]?.c
      if (context === undefined || context === null) return full()
      await current()
      const contextKey = digest([actor, context]), key = digest([contextKey, exactKey(roots)]), hit = closure.proofs.get(key)
      if (hit !== undefined && !closure.disposed) { closure.counters.sharedProofs++; return structuredClone(hit) as T }
      if (closure.disposed || options.locked) return full()
      /** The same question with roots added that the stored proof already
       * reached: the capture walks the same closure from either root set
       * (every added root is one of its nodes), so its nodes, evaluation and
       * current obligations are the stored proof's. The added roots are proved
       * on their own (their kind and lineage checks included); only when that
       * is admitted is the result derived, otherwise the full proof decides. */
      const extendProof = async (contextKey: string, key: string): Promise<T | null> => {
        const wanted = new Map(roots.map(root => [labelledNode(root), root]))
        for (const [baseKey, shape] of closure.proofShapes) {
          const base = closure.proofs.get(baseKey) as T | undefined
          if (!base || shape.context !== contextKey || [...shape.roots].some(root => !wanted.has(root))) continue
          const added = [...wanted].filter(([root]) => !shape.roots.has(root)).map(([, root]) => root)
          if (!added.length || added.some(root => !shape.nodes.has(exactNode(root)))) continue
          const epoch = closure.epoch
          // A refusal or failure of the added roots alone is never inherited: the full proof decides.
          const delta = await prove(added).catch(() => null)
          if (!delta || closure.disposed || closure.epoch !== epoch || closure.proofs.get(baseKey) !== base) return null
          const derived = { ...structuredClone(base), evidence: new ContextScopeAccumulator({ sources: [...roots, ...base.evidence.sources ?? []] }).evidence } as T
          closure.proofs.set(key, structuredClone(derived))
          closure.proofShapes.set(key, { context: contextKey, roots: new Set(wanted.keys()), nodes: shape.nodes })
          closure.counters.extendedProofs++
          return derived
        }
        return null
      }
      const extended = await extendProof(contextKey, key)
      if (extended) return extended
      closure.counters.proofs++
      const value = await produce(closure.proofs as Map<string, unknown>, key, roots, full,
        proof => proof ? [...proof.evidence.sources ?? [], ...proof.current] : null)
      if (value && closure.proofs.has(key)) closure.proofShapes.set(key, { context: contextKey,
        roots: new Set(roots.map(labelledNode)), nodes: new Set([...value.evidence.sources ?? [], ...value.current].map(exactNode)) })
      return value
    },
  })
}
