import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'

/**
 * Bounded per-turn SQL accounting: which statements one turn sent, attributed
 * to the frame that sent them, so permission and transaction-control work can
 * be counted per turn (docs/plans/oss-chat-architecture-replacement.md §7:
 * incomplete permission-work accounting is unqualified, not a pass).
 *
 * The pool client instrumentation in `client.ts` reports every statement here;
 * this module records it only when recording is enabled AND a frame is active.
 * It never reads parameter values and never retains raw SQL text: a statement
 * is kept as a literal-free, truncated shape plus a hash of the full shape.
 *
 * Spec: docs/architecture/platform/database-schema.md → "Per-turn SQL
 * accounting frames". Component-map tag: [COMP:api/db-turn-sql-accounting].
 */

/** Environment flag that enables recording at process start (`1` = on). */
export const TURN_SQL_ACCOUNTING_ENV = 'BRIAN_TURN_SQL_ACCOUNTING'
/** Retained statement entries per turn; totals keep counting past it. */
export const TURN_SQL_MAX_STATEMENTS = 1_000
/** Distinct fingerprint buckets per turn; later new shapes count as overflow. */
export const TURN_SQL_MAX_FINGERPRINTS = 256
/** Distinct frame ids tracked per turn. */
export const TURN_SQL_MAX_FRAMES = 256
/** Turns held in memory; the oldest is evicted first. */
export const TURN_SQL_MAX_TURNS = 32
/** Retained shape length (the hash covers the full normalized shape). */
export const TURN_SQL_SHAPE_MAX_CHARS = 200
/** Normalization reads at most this much SQL text. */
const NORMALIZE_MAX_INPUT_CHARS = 16_384
/** Turn and frame identifiers are truncated to this length. */
const ID_MAX_CHARS = 128

export type SqlPoolLabel = 'app' | 'system' | 'single'

export interface TurnFrame {
  readonly turnId: string
  readonly frameId: string
  readonly parentFrameId: string | null
  readonly depth: number
}

export interface TurnSqlStatement {
  readonly seq: number
  readonly frameId: string
  readonly parentFrameId: string | null
  readonly depth: number
  readonly hash: string
  readonly shape: string
  readonly paramCount: number
  readonly pool: SqlPoolLabel
  readonly elapsedMs: number
  readonly control: boolean
  readonly ok: boolean
}

export interface TurnSqlFingerprint {
  readonly hash: string
  readonly shape: string
  readonly control: boolean
  readonly count: number
  readonly elapsedMs: number
}

export interface TurnSqlLedger {
  readonly turnId: string
  /** Retained entries in submission-completion order, at most TURN_SQL_MAX_STATEMENTS. */
  readonly statements: readonly TurnSqlStatement[]
  readonly fingerprints: readonly TurnSqlFingerprint[]
  readonly totals: {
    readonly statements: number
    readonly control: number
    readonly failed: number
    readonly elapsedMs: number
    readonly byPool: Readonly<Record<SqlPoolLabel, number>>
    readonly frames: number
  }
  readonly overflow: {
    /** Statements counted in totals but not retained as entries. */
    readonly statements: number
    /** Statements whose new shape found no free fingerprint bucket. */
    readonly fingerprints: number
    /** Frames beyond TURN_SQL_MAX_FRAMES. */
    readonly frames: number
  }
}

interface MutableLedger {
  turnId: string
  seq: number
  statements: TurnSqlStatement[]
  fingerprints: Map<string, { hash: string; shape: string; control: boolean; count: number; elapsedMs: number }>
  frames: Set<string>
  totals: { statements: number; control: number; failed: number; elapsedMs: number; byPool: Record<SqlPoolLabel, number> }
  overflow: { statements: number; fingerprints: number; frames: number }
}

interface FrameStore {
  frame: TurnFrame
  /** Shared by every nested frame of the same turn; created on first record. */
  holder: { ledger?: MutableLedger }
}

const frameStorage = new AsyncLocalStorage<FrameStore>()
const ledgers = new Map<string, MutableLedger>()
const envEnabled = process.env[TURN_SQL_ACCOUNTING_ENV] === '1'
let recordingOverride: boolean | undefined

function boundedId(value: string): string {
  return String(value).slice(0, ID_MAX_CHARS)
}

/**
 * Run `fn` inside a turn frame. A nested call records its parent frame and
 * depth; frames with the same `turnId` share one ledger, while a nested frame
 * with a different `turnId` records only into its own ledger.
 */
export function withTurnFrame<T>(frame: { turnId: string; frameId: string }, fn: () => T): T {
  const parent = frameStorage.getStore()
  const turnId = boundedId(frame.turnId)
  const sameTurn = parent?.frame.turnId === turnId
  const store: FrameStore = {
    frame: {
      turnId,
      frameId: boundedId(frame.frameId),
      parentFrameId: parent ? parent.frame.frameId : null,
      depth: parent ? parent.frame.depth + 1 : 0,
    },
    holder: sameTurn ? parent.holder : {},
  }
  return frameStorage.run(store, fn)
}

/** The innermost active turn frame, or undefined outside any frame. */
export function currentTurnFrame(): TurnFrame | undefined {
  return frameStorage.getStore()?.frame
}

/**
 * Test hook: force recording on or off; `undefined` restores the environment
 * default (`BRIAN_TURN_SQL_ACCOUNTING=1` read at process start, otherwise off).
 */
export function setTurnSqlRecording(enabled: boolean | undefined): void {
  recordingOverride = enabled
}

export function turnSqlRecordingEnabled(): boolean {
  return recordingOverride ?? envEnabled
}

/**
 * Literal-free shape of a statement and a hash of the full shape. Removes
 * comments, string/dollar-quoted/numeric literals and `$n` placeholders,
 * collapses `?` lists and whitespace. Never sees parameter values.
 */
export function fingerprintSql(text: string): { shape: string; hash: string } {
  const normalized = stripLiteralsAndComments(String(text).slice(0, NORMALIZE_MAX_INPUT_CHARS))
    .replace(/\$\d+/g, '?')
    .replace(/(?<![A-Za-z0-9_."$])\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![A-Za-z0-9_])/g, '?')
    .replace(/\s+/g, ' ')
    .replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, '(?...)')
    .replace(/\[\s*\?(?:\s*,\s*\?)+\s*\]/g, '[?...]')
    .replace(/\(\?(?:\.\.\.)?\)(?:\s*,\s*\(\?(?:\.\.\.)?\))+/g, '(?...),...')
    .trim()
    .replace(/\s*;$/, '')
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 16)
  return { shape: normalized.slice(0, TURN_SQL_SHAPE_MAX_CHARS), hash }
}

/**
 * One left-to-right pass so a quote inside a comment, or `--` inside a string,
 * cannot desynchronize the other rule. String constants (including `E'...'`
 * escapes) and dollar-quoted bodies become `?`; comments become a space;
 * quoted identifiers are copied verbatim. Unterminated input runs to the end.
 */
function stripLiteralsAndComments(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]!
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i + 2)
      i = end === -1 ? n : end
      out += ' '
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      out += ' '
    } else if (ch === "'") {
      const last = out[out.length - 1]
      const escapes = (last === 'E' || last === 'e') && !isIdentifierChar(out[out.length - 2])
      if (escapes) out = out.slice(0, -1)
      i++
      while (i < n) {
        if (escapes && sql[i] === '\\') { i += 2; continue }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue }
          i++
          break
        }
        i++
      }
      out += '?'
    } else if (ch === '"') {
      const end = sql.indexOf('"', i + 1)
      const stop = end === -1 ? n : end + 1
      out += sql.slice(i, stop)
      i = stop
    } else if (ch === '$' && !isIdentifierChar(out[out.length - 1])) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 66))
      if (!tag) { out += ch; i++; continue }
      const end = sql.indexOf(tag[0], i + tag[0].length)
      i = end === -1 ? n : end + tag[0].length
      out += '?'
    } else {
      out += ch
      i++
    }
  }
  return out
}

function isIdentifierChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch)
}

const CONTROL_STATEMENT =
  /^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|SET|RESET|DISCARD)\b|^SELECT\s+set_config\s*\(/i

/** Transaction and session-setting control, as opposed to data work. */
export function isControlStatement(text: string): boolean {
  return CONTROL_STATEMENT.test(String(text).replace(/^\s+/, ''))
}

function ledgerFor(store: FrameStore): MutableLedger {
  if (store.holder.ledger) return store.holder.ledger
  const turnId = store.frame.turnId
  let ledger = ledgers.get(turnId)
  if (!ledger) {
    ledger = {
      turnId,
      seq: 0,
      statements: [],
      fingerprints: new Map(),
      frames: new Set(),
      totals: { statements: 0, control: 0, failed: 0, elapsedMs: 0, byPool: { app: 0, system: 0, single: 0 } },
      overflow: { statements: 0, fingerprints: 0, frames: 0 },
    }
    ledgers.set(turnId, ledger)
    while (ledgers.size > TURN_SQL_MAX_TURNS) {
      const oldest = ledgers.keys().next().value
      if (oldest === undefined) break
      ledgers.delete(oldest)
    }
  }
  store.holder.ledger = ledger
  return ledger
}

/** Opaque handle to the frame active when a statement was submitted. */
export type TurnSqlScope = { readonly [scopeBrand]: true }
declare const scopeBrand: unique symbol

/**
 * Capture the active frame at statement submission, or undefined when
 * recording is off or no frame is active. Completion callbacks can run in an
 * unrelated async context (a pooled connection's socket), so the recorder
 * attributes a statement to this captured scope rather than to whatever frame
 * is current when it completes.
 */
export function captureTurnSqlScope(): TurnSqlScope | undefined {
  if (!turnSqlRecordingEnabled()) return undefined
  return frameStorage.getStore() as unknown as TurnSqlScope | undefined
}

/**
 * Reports one completed statement. Cheap no-op unless recording is enabled
 * and a frame is active. Called by the pool client instrumentation with the
 * scope captured at submission; without one it falls back to the current frame.
 */
export function recordTurnSqlStatement(input: {
  text: string
  paramCount: number
  pool: SqlPoolLabel
  elapsedMs: number
  ok: boolean
}, scope?: TurnSqlScope): void {
  if (!turnSqlRecordingEnabled()) return
  const store = scope !== undefined ? scope as unknown as FrameStore : frameStorage.getStore()
  if (!store) return
  const ledger = ledgerFor(store)
  const { shape, hash } = fingerprintSql(input.text)
  const control = isControlStatement(shape)
  const elapsedMs = Math.max(0, input.elapsedMs)
  const frame = store.frame

  ledger.totals.statements++
  if (control) ledger.totals.control++
  if (!input.ok) ledger.totals.failed++
  ledger.totals.elapsedMs += elapsedMs
  ledger.totals.byPool[input.pool]++

  if (!ledger.frames.has(frame.frameId)) {
    if (ledger.frames.size < TURN_SQL_MAX_FRAMES) ledger.frames.add(frame.frameId)
    else ledger.overflow.frames++
  }

  const bucket = ledger.fingerprints.get(hash)
  if (bucket) {
    bucket.count++
    bucket.elapsedMs += elapsedMs
  } else if (ledger.fingerprints.size < TURN_SQL_MAX_FINGERPRINTS) {
    ledger.fingerprints.set(hash, { hash, shape, control, count: 1, elapsedMs })
  } else {
    ledger.overflow.fingerprints++
  }

  const seq = ++ledger.seq
  if (ledger.statements.length < TURN_SQL_MAX_STATEMENTS) {
    ledger.statements.push(Object.freeze({
      seq,
      frameId: frame.frameId,
      parentFrameId: frame.parentFrameId,
      depth: frame.depth,
      hash,
      shape,
      paramCount: Math.max(0, Math.trunc(input.paramCount)),
      pool: input.pool,
      elapsedMs,
      control,
      ok: input.ok,
    }))
  } else {
    ledger.overflow.statements++
  }
}

function snapshot(ledger: MutableLedger): TurnSqlLedger {
  return Object.freeze({
    turnId: ledger.turnId,
    statements: Object.freeze([...ledger.statements]),
    fingerprints: Object.freeze([...ledger.fingerprints.values()].map((f) => Object.freeze({ ...f }))),
    totals: Object.freeze({
      ...ledger.totals,
      byPool: Object.freeze({ ...ledger.totals.byPool }),
      frames: ledger.frames.size + ledger.overflow.frames,
    }),
    overflow: Object.freeze({ ...ledger.overflow }),
  })
}

/** Immutable snapshot of a turn's ledger, or undefined if none was recorded or it was evicted. */
export function readTurnSqlLedger(turnId: string): TurnSqlLedger | undefined {
  const ledger = ledgers.get(boundedId(turnId))
  return ledger ? snapshot(ledger) : undefined
}

/** Snapshot and forget a turn's ledger (the kernel's turn-end read). */
export function takeTurnSqlLedger(turnId: string): TurnSqlLedger | undefined {
  const id = boundedId(turnId)
  const ledger = ledgers.get(id)
  if (!ledger) return undefined
  ledgers.delete(id)
  return snapshot(ledger)
}

/**
 * Integer counters for the numeric `turn_timings` snapshot. `sql_repeat_count`
 * (statements minus distinct shapes) is exact only while
 * `sql_fingerprint_overflow_count` is 0.
 */
export function turnSqlCounters(ledger: TurnSqlLedger): Record<string, number> {
  return {
    sql_statement_count: ledger.totals.statements,
    sql_control_count: ledger.totals.control,
    sql_failed_count: ledger.totals.failed,
    sql_app_count: ledger.totals.byPool.app,
    sql_system_count: ledger.totals.byPool.system,
    sql_single_count: ledger.totals.byPool.single,
    sql_statement_ms: Math.round(ledger.totals.elapsedMs),
    sql_fingerprint_count: ledger.fingerprints.length,
    sql_repeat_count: Math.max(0, ledger.totals.statements - ledger.fingerprints.length - ledger.overflow.fingerprints),
    sql_frame_count: ledger.totals.frames,
    sql_statement_overflow_count: ledger.overflow.statements,
    sql_fingerprint_overflow_count: ledger.overflow.fingerprints,
    sql_frame_overflow_count: ledger.overflow.frames,
  }
}

/** Test hook: drop every retained ledger. */
export function resetTurnSqlLedgers(): void {
  ledgers.clear()
}
