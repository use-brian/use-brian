// [COMP:crm/reference-erp-adapter] Reference ERP adapter client boundary.
// The end-to-end proof against the real API is erp-bridge.integration.test.ts;
// this suite pins the adapter's own contract at its HTTP boundary.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { ReferenceErpAdapter, LegacyWriterRetired, canonicalJson, sha256 } from '../reference-erp-adapter.mjs'

const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/professional-services-erp.v1.json', import.meta.url), 'utf8'))
const state = { writerState: 'legacy', requests: [], dropNext: 0, events: [], mappings: new Map() }
let server, baseUrl
before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const url = new URL(req.url, 'http://local')
      const parsed = body ? JSON.parse(body) : null
      state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: parsed })
      const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
      if (url.pathname.endsWith(`/operations/erp-bindings/${FIXTURE.binding.bindingKey}`)) return json(200, { binding: { writerState: state.writerState } })
      if (url.pathname.endsWith('/operations/projection-events')) {
        const cursor = Number(url.searchParams.get('cursor') ?? 0)
        return json(200, { events: state.events.filter((event) => Number(event.seq) > cursor), nextCursor: null })
      }
      if (url.pathname.endsWith('/operations/legacy-mappings')) {
        const found = state.mappings.get(url.searchParams.get('targetId') ?? url.searchParams.get('legacyId'))
        return found ? json(200, found) : json(404, { error: 'not_found' })
      }
      if (url.pathname.endsWith('/operations/commands')) {
        if (state.dropNext > 0) { state.dropNext--; return json(502, { error: 'upstream_timeout' }) }
        if (parsed.kind === 'record_projection_receipt') {
          return json(200, { record: { outcomes: (parsed.receipts ?? []).map((receipt) => ({ ...receipt, outcome: 'applied' }))
            .concat((parsed.resynced ?? []).map((item) => ({ ...item, outcome: 'resynced' }))) } })
        }
        if (parsed.kind === 'stage_erp_import' && parsed.records.clients.some((row) => row.legacyId === 'CL-BAD')) return json(409, { error: 'conflict', details: { reason: 'writer_retired' } })
        return json(200, { record: { echoed: parsed.kind } })
      }
      json(404, { error: 'not_found' })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})
after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
const adapter = () => new ReferenceErpAdapter({ baseUrl, token: 'sk_crm_fixture', fixture: FIXTURE })

describe('[COMP:crm/reference-erp-adapter] reference ERP adapter boundary', () => {
  it('hashes exports in the CRM canonical form, independent of insertion order', () => {
    assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 1 }] }), '{"a":[{"c":1,"d":2}],"b":1}')
    const first = adapter().exportRecords()
    const shuffled = adapter()
    shuffled.store.clients = new Map([...shuffled.store.clients.entries()].reverse())
    assert.equal(shuffled.exportRecords().exportHash, first.exportHash)
    assert.equal(first.exportHash, sha256(first.records))
    assert.deepEqual(first.counts, { client: FIXTURE.clients.length, engagement: FIXTURE.engagements.length })
  })

  it('retries an uncertain outcome with the same operation id and sends viewer identity only when asked', async () => {
    state.requests.length = 0
    state.dropNext = 2
    const client = adapter()
    await client.command({ kind: 'update_engagement_tracking' }, { viewer: 'u-staff' })
    const posts = state.requests.filter((request) => request.method === 'POST')
    assert.equal(posts.length, 3)
    assert.equal(new Set(posts.map((request) => request.body.operationId)).size, 1)
    assert.equal(posts[0].headers['x-crm-viewer'], 'u-staff')
    assert.equal(posts[0].headers['x-crm-binding'], FIXTURE.binding.bindingKey)
    assert.equal(posts[0].headers.authorization, 'Bearer sk_crm_fixture')
    await client.command({ kind: 'stage_erp_import', records: { clients: [] } })
    assert.equal(state.requests.at(-1).headers['x-crm-viewer'], undefined)
    // A definite refusal is not retried.
    state.requests.length = 0
    await assert.rejects(client.command({ kind: 'stage_erp_import', records: { clients: [{ legacyId: 'CL-BAD' }] } }), { status: 409, code: 'conflict' })
    assert.equal(state.requests.length, 1)
  })

  it('refuses legacy writes once the CRM freezes or retires the writer', async () => {
    const client = adapter()
    state.writerState = 'legacy'
    await client.legacyWrite('engagement', 'EN-4', { workStatus: 'fieldwork' })
    assert.equal(client.store.engagements.get('EN-4').workStatus, 'fieldwork')
    state.writerState = 'frozen'
    await assert.rejects(client.legacyWrite('engagement', 'EN-4', { workStatus: 'complete' }), (error) => error instanceof LegacyWriterRetired && error.state === 'frozen')
    state.writerState = 'brian'
    await assert.rejects(client.legacyWrite('client', 'CL-100', { name: 'Late' }), (error) => error instanceof LegacyWriterRetired && error.state === 'brian')
    assert.equal(client.store.engagements.get('EN-4').workStatus, 'fieldwork')
    state.writerState = 'legacy'
  })

  it('applies projection versions in order, resyncs gaps, and exports only projection fields', async () => {
    const subject = '00000000-0000-4000-8000-0000000000e1'
    const projection = (version, code) => ({ subjectKind: 'deal', subjectId: subject, name: 'Example engagement', legacyIds: ['EN-1'], workStatus: 'fieldwork',
      serviceCategory: 'audit', financialPeriod: 'FY2026', codes: { current: [{ definitionKey: 'job-code', value: code }], former: version > 1 ? [{ definitionKey: 'job-code', value: 'J-0001' }] : [] },
      client: { name: 'Example client', codes: { current: [{ definitionKey: 'client-code', value: 'C-0100' }], former: [] }, legacyIds: ['CL-100'] } })
    state.events = [{ seq: '1', subjectId: subject, version: 1, tombstone: false, projection: projection(1, 'J-0001') },
      { seq: '2', subjectId: subject, version: 1, tombstone: false, projection: projection(1, 'J-0001') },
      { seq: '3', subjectId: subject, version: 3, tombstone: false, projection: projection(3, 'J-0101') }]
    state.mappings.set(subject, { mapping: { targetId: subject }, projection: projection(3, 'J-0101'), version: 3 })
    const client = adapter()
    const synced = await client.syncProjections()
    assert.deepEqual(synced.applied.map((row) => row.version), [1])
    assert.deepEqual(synced.resynced, [{ subjectId: subject, version: 3 }])
    const lookup = client.timesheetLookup('T-1')
    assert.equal(lookup.engagement.code, 'J-0101')
    assert.deepEqual(lookup.engagement.formerCodes, ['J-0001'])
    assert.equal(lookup.engagementLegacyId, 'EN-1')
    const exported = client.exportEngagements()
    assert.deepEqual(exported.rows, [['J-0101', 'Example engagement', 'C-0100', 'Example client', 'fieldwork', 'audit', 'FY2026']])
    assert.doesNotMatch(JSON.stringify(exported), /Fee|amount/)
    assert.equal(FIXTURE.exportPresets['engagement-list'].some((column) => /fee|amount/i.test(column.source)), false)
  })
})
