#!/usr/bin/env node
/** Cross-check actual chat release invocations against the owned executor trace. */
import { createHash } from 'node:crypto'
import { createReadStream, statSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const owners = [
  'admit_native_turn_conversation_records',
  'capture_native_turn_conversation_record',
  'capture_conversation_evidence',
]
const granularUnits = /^(scalar-array:|btree-comparator$|sort-|merge-join-|hash-join-|hashed-subplan-)/
const preparationPhases = new Set(['planning', 'rewrite'])
const permissionUnits = /^(permission:|planner:)/
// PostgreSQL 18.7 generated nodes/nodetags.h. Earlier probe binaries retained
// the tag for these executed nodes without giving them a name.
const unnamedNodes = { 335: 'MergeAppend', 338: 'BitmapOr', 366: 'WindowAgg' }
const structuralNodes = new Set(['Append', 'BitmapOr', 'CteScan', 'LockRows', 'SubqueryScan', 'ValuesScan', 'WorkTableScan'])
const specializedNodes = new Set(['Agg', 'IncrementalSort', 'MergeAppend', 'RecursiveUnion', 'SetOp', 'Unique', 'WindowAgg'])
const opaqueFunctionNodes = new Set(['FunctionScan', 'ProjectSet'])
const entryProbes = {
  aggregateExpressions: /^expression:EEOP_AGG_/,
  distinctExpressions: /^expression:EEOP_(NOT_DISTINCT|DISTINCT|AGG_PRESORTED_DISTINCT)/,
  qualifierExpressions: /^expression:EEOP_QUAL$/,
  functionManagerCalls: /^fmgr-invoke$/,
}

function classifyInventoryNode(node) {
  const kind = node.node === 'unsupported' ? unnamedNodes[node.tag] ?? node.node : node.node
  const category = node.am && node.am !== 'btree' ? 'uncovered-access-method'
    : structuralNodes.has(kind) ? 'structural-with-expression-and-child-inventory'
    : specializedNodes.has(kind) ? 'specialized-with-partial-callback-inventory'
    : opaqueFunctionNodes.has(kind) ? 'function-entry-inventory-with-opaque-body'
    : kind === 'ModifyTable' ? 'write-and-constraint-inventory' : 'unclassified'
  return { kind, category, tag: node.tag, accessMethod: node.am }
}

function permissionCounts(counters, defaultPhase) {
  const result = {}
  for (const { kind, phase = defaultPhase, calls } of counters) {
    if (!permissionUnits.test(kind)) continue
    if (phase !== 'execution' && !preparationPhases.has(phase) || !Number.isSafeInteger(calls) || calls < 1) {
      throw new Error('Malformed planning or permission counter')
    }
    const units = result[phase] ??= {}
    units[kind] = (units[kind] ?? 0) + calls
  }
  return result
}

export async function profileReleases(chatPath, tracePath) {
  const { results } = JSON.parse(readFileSync(chatPath, 'utf8'))
  if (!Array.isArray(results) || results.length !== 1 || results[0].verified !== true) {
    throw new Error('Release profiler requires one verified owned chat result')
  }
  const chat = results[0]
  if (!Array.isArray(chat.queryWork) || chat.queryWork.some(row => typeof row.shape !== 'string' || !Number.isSafeInteger(row.calls) || row.calls < 1)
    || chat.queryWork.reduce((sum, row) => sum + row.calls, 0) !== chat.queries) {
    throw new Error('Chat statement ledger is incomplete')
  }
  const expected = Object.fromEntries(owners.map(owner => [owner, chat.queryWork
    .filter(row => row.shape.includes(`${owner}(`)).reduce((sum, row) => sum + row.calls, 0)]))
  if (!Object.values(expected).some(Boolean)) throw new Error('Chat exercised no reviewed release owner')

  if (statSync(tracePath).size > 128 * 1024 * 1024) throw new Error('Executor trace exceeds the single-case budget')
  const hash = createHash('sha256')
  const input = createReadStream(tracePath)
  input.on('data', chunk => hash.update(chunk))
  const lines = createInterface({ input, crlfDelay: Infinity })
  const releases = [], inventoryByOwner = {}, preparationByOwner = {}
  let windowEnd, records = 0, overflowingRecords = 0
  for await (const line of lines) {
    if (windowEnd) continue
    const row = JSON.parse(line)
    if (row.windowEnd) { windowEnd = row; continue }
    if (row.collectorEnabled !== true || !Object.hasOwn(row, 'releaseOwner')) {
      throw new Error('Trace is missing the enabled release collector schema')
    }
    if (row.releaseOwner !== null && !owners.includes(row.releaseOwner) || !Array.isArray(row.counters)) {
      throw new Error('Malformed probe record')
    }
    if (row.overflow) overflowingRecords++
    const phase = row.phase ?? 'execution'
    const measuredPermissions = permissionCounts(row.counters, phase)
    if (preparationPhases.has(phase)) {
      if (typeof row.succeeded !== 'boolean') throw new Error('Malformed preparation record')
      const preparation = preparationByOwner[row.releaseOwner ?? 'other'] ??= {}
      const summary = preparation[phase] ??= { records: 0, failed: 0, counters: {} }
      summary.records++
      if (!row.succeeded) summary.failed++
      for (const [sourcePhase, counts] of Object.entries(measuredPermissions)) {
        const units = summary.counters[sourcePhase] ??= {}
        for (const [kind, calls] of Object.entries(counts)) units[kind] = (units[kind] ?? 0) + calls
      }
      continue
    }
    if (phase !== 'execution' || !Number.isSafeInteger(row.nestedExecutorStarts) || row.nestedExecutorStarts < 0
      || !Array.isArray(row.executedNodes)) throw new Error('Malformed execution record')
    records++
    const inventory = inventoryByOwner[row.releaseOwner ?? 'other'] ??= { statements: 0, inventoryOnlyStatements: 0, nodes: {}, observedEntryStatements: {} }
    inventory.statements++
    for (const [name, pattern] of Object.entries(entryProbes)) {
      if (row.counters.some(counter => pattern.test(counter.kind))) {
        inventory.observedEntryStatements[name] = (inventory.observedEntryStatements[name] ?? 0) + 1
      }
    }
    const inventoryOnlyNodes = row.executedNodes.filter(node => node.calibrated !== true).map(classifyInventoryNode)
    if (inventoryOnlyNodes.length) inventory.inventoryOnlyStatements++
    const unique = new Map(inventoryOnlyNodes.map(node => [`${node.tag}:${node.accessMethod ?? 'none'}`, node]))
    for (const [key, node] of unique) {
      const item = inventory.nodes[key] ??= { ...node, statements: 0 }
      item.statements++
    }
    if (row.releaseOwner === null) continue
    const counters = {}
    for (const { kind, calls } of row.counters) {
      if (!granularUnits.test(kind)) continue
      if (!Number.isSafeInteger(calls) || calls < 1) throw new Error('Malformed release counter')
      counters[kind] = (counters[kind] ?? 0) + calls
    }
    releases.push({ owner: row.releaseOwner, nestedExecutorStarts: row.nestedExecutorStarts, counters,
      permissionCounters: measuredPermissions, inventoryOnlyNodes, executedJit: row.executedJit })
  }
  const observed = Object.fromEntries(owners.map(owner => [owner, releases.filter(row => row.owner === owner).length]))
  const matched = windowEnd?.foregroundStatements === chat.queries && overflowingRecords === 0
    && owners.every(owner => expected[owner] === observed[owner])
  return {
    matched, queryTraceSha256: hash.digest('hex'), scenario: chat.scenario, permissionModel: chat.permissionModel,
    receivedTextSha256: chat.receivedTextSha256 ?? null, savedTextSha256: chat.savedTextSha256 ?? null,
    expected, observed, records, overflowingRecords, windowEnd: windowEnd ?? null, releases, inventoryByOwner, preparationByOwner,
    physicalPermissionCoverageComplete: false,
    scope: 'The execution release roster matches observed foreground calls. Planning and rewrite are separate operations; a cache hit need not prepare a plan. ACL, RLS, and role observations are engine permission primitives. Expression callbacks still include business work and overlap other measures.',
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [chat, trace, output] = process.argv.slice(2)
  if (process.argv.length !== 5 || !chat || !trace || !output) throw new Error('Usage: release-profile.mjs CHAT.json TRACE.jsonl NEW-OUTPUT.json')
  const result = await profileReleases(chat, trace)
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  if (!result.matched) process.exitCode = 1
  console.log(JSON.stringify({ matched: result.matched, releases: result.observed, output }))
}
