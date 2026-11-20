/** Real fixture-only HTTP actions. No connector sends, publication or external credentials.
 * [COMP:invariants/chat-import-graph] */
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { runMailboxArchiveProbe } from './mailbox-archive-probe.mjs'

function find(value, predicate, budget = { remaining: 2000 }) {
  if (--budget.remaining < 0 || !value || typeof value !== 'object') return null
  if (predicate(value)) return value
  for (const child of Object.values(value)) { const found = find(child, predicate, budget); if (found) return found }
  return null
}
function requireStatus(response, allowed, step) {
  if (!allowed.includes(response.status)) throw new Error(`${step}: HTTP ${response.status}`)
}
export async function executeActivationProbe(id, context) {
  const { port, accessToken, turn, workers, provider, fixtureDocSyncSecret } = context
  if (!accessToken) throw new Error('Activation requires the canonical fixture identity')
  const request = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const multipart = body instanceof FormData
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${accessToken}`, ...(!multipart && body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }) })
    return { status: response.status, body: await response.json().catch(() => null) }
  }
  const { workspaceId } = turn
  if (id === 'crm-contact-create') {
    const name = `Fictional M4 Contact ${randomUUID()}`
    const created = await request(`/api/crm/${workspaceId}/records`, { kind: 'contact', name, email: 'm4-fixture@example.test' })
    requireStatus(created, [201], 'CRM create')
    const record = typeof created.body?.id === 'string' ? created.body : null
    if (!record) throw new Error('CRM create did not return its fictional record')
    const reopened = await request(`/api/crm/${workspaceId}/records/${record.id}`)
    requireStatus(reopened, [200], 'CRM reopen')
    if (!find(reopened.body, value => value.id === record.id && value.name === name)) throw new Error('CRM reopened record differs')
    return { status: 'pass', httpStatus: created.status, recordId: record.id, durableReopen: true }
  }
  if (id === 'campaign-draft') {
    const name = `Fictional M4 Draft ${randomUUID()}`
    const created = await request('/api/campaigns/commands', { workspaceId, idempotencyKey: randomUUID(), command: {
      kind: 'save_campaign', name, objective: 'Local acceptance fixture only', timezone: 'UTC', primaryConversion: 'enquiry_submitted' } })
    requireStatus(created, [201], 'Campaign draft')
    const listed = await request(`/api/campaigns?workspaceId=${workspaceId}&state=draft`)
    requireStatus(listed, [200], 'Campaign list')
    const campaign = find(listed.body, value => typeof value.id === 'string' && value.name === name)
    if (!campaign) throw new Error('Campaign draft did not reach its normal list')
    const reopened = await request(`/api/campaigns/${campaign.id}?workspaceId=${workspaceId}`)
    requireStatus(reopened, [200], 'Campaign reopen')
    return { status: 'pass', httpStatus: created.status, campaignId: campaign.id, durableReopen: true, externalPublication: false }
  }
  if (id === 'office-docx-pdf-export') {
    const template = await request('/api/office/templates', { workspaceId, family: 'document', name: 'Fictional M4 export fixture',
      description: 'A local qualification document containing fictional acceptance text only.', creationMethod: 'guided', companyHasNoWebsite: true, sensitivity: 'internal' })
    requireStatus(template, [201], 'Office fixture creation')
    const artifactId = template.body?.draftArtifactId
    if (typeof artifactId !== 'string') throw new Error('Office fixture has no artifact')
    const live = await request(`/api/office/artifacts/${artifactId}/snapshot`)
    requireStatus(live, [200], 'Office live draft')
    if (!live.body?.snapshot || !Number.isInteger(live.body.baseVersion) || !fixtureDocSyncSecret) {
      throw new Error('Office checkpoint fixture is incomplete')
    }
    const canonicalHash = createHash('sha256').update(JSON.stringify(live.body.snapshot)).digest('hex')
    if (canonicalHash !== live.body.canonicalHash) throw new Error('Office draft was not initialized with its materialized hash')
    const checkpoint = hash => fetch(`http://127.0.0.1:${port}/internal/office-checkpoint`, {
      method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json', 'x-doc-sync-secret': fixtureDocSyncSecret },
      body: JSON.stringify({ artifactId, expectedVersion: live.body.baseVersion, canonicalHash: hash }),
    })
    const wrongHash = (canonicalHash[0] === '0' ? '1' : '0') + canonicalHash.slice(1)
    requireStatus(await checkpoint(wrongHash), [409], 'Office checkpoint with a mismatched document hash')
    const saved = await checkpoint(canonicalHash)
    requireStatus(saved, [201], 'Office immutable checkpoint')
    const repeat = await checkpoint(canonicalHash)
    requireStatus(repeat, [201], 'Office checkpoint retry')
    const { version: checkpointedVersion } = await saved.json()
    if ((await repeat.json()).version !== checkpointedVersion) throw new Error('Office checkpoint retry created a different head')
    const read = await request(`/api/office/artifacts/${artifactId}`)
    requireStatus(read, [200], 'Office reopen')
    const expectedVersion = read.body?.artifact?.version
    const versions = await request(`/api/office/artifacts/${artifactId}/versions`)
    requireStatus(versions, [200], 'Office version history')
    if (!Number.isInteger(expectedVersion) || expectedVersion !== checkpointedVersion
       || !versions.body?.versions?.some(version => version.version === expectedVersion)) {
      throw new Error('Office durable version missing')
    }
    const exports = []
    for (const format of ['native', 'pdf']) {
      const exported = await request(`/api/office/artifacts/${artifactId}/releases`, { expectedVersion, action: 'export',
        destination: { sensitivity: 'internal', external: false }, format })
      if (exported.status !== 201) return { status: 'fail', stage: `office-${format}`, httpStatus: exported.status,
        refusalCode: exported.body?.error ?? exported.body?.receipt?.status ?? 'release_refused', artifactId,
        blocks: exported.body?.receipt?.blocks?.map(issue => issue.code) ?? [],
        completedExports: exports, reason: 'Normal release route refused the fixture; no warning acknowledgement was invented' }
      if (typeof exported.body?.fileId !== 'string' || !/^[a-f0-9]{64}$/.test(exported.body?.sha256 ?? '')) throw new Error(`Office ${format} has no saved file receipt`)
      const file = await fetch(`http://127.0.0.1:${port}/api/doc-files/${workspaceId}/${exported.body.fileId}`, {
        headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000),
      })
      requireStatus(file, [200], 'Released Office file reopen')
      const bytes = Buffer.from(await file.arrayBuffer())
      const signature = format === 'native' ? '504b0304' : '255044462d'
      if (!bytes.toString('hex', 0, signature.length / 2).startsWith(signature)
        || createHash('sha256').update(bytes).digest('hex') !== exported.body.sha256) throw new Error(`Office ${format} exported bytes changed`)
      exports.push({ format, fileId: exported.body.fileId, sha256: exported.body.sha256, bytes: bytes.length })
    }
    return { status: 'pass', artifactId, checkpointedVersion, pristine: true, mismatchedHashRejected: true, exports, externalPublication: false }
  }
  if (id === 'file-ingest-job') {
    const source = 'Fictional M4 ingest fixture. This local document has no customer information.'
    const form = new FormData(); form.set('workspaceId', workspaceId)
    form.append('files', new Blob([source], { type: 'text/plain' }), 'fictional-m4-ingest.txt')
    const queued = await request('/api/files/ingest', form)
    requireStatus(queued, [200, 202], 'File ingest enqueue')
    const job = find(queued.body, value => typeof value.jobId === 'string')
    if (!job) throw new Error('File ingest did not return its durable job')
    if (!workers) {
      const read = await request(`/api/files/ingest-jobs/${job.jobId}`)
      requireStatus(read, [200], 'Workers-disabled file ingest reopen')
      if (read.body?.jobId !== job.jobId || read.body.status !== 'pending') {
        throw new Error('The file-ingest job did not reopen pending with workers disabled')
      }
      return { status: 'pass', jobId: job.jobId, queued: true, completed: false, durableReopen: true }
    }
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      const read = await request(`/api/files/ingest-jobs/${job.jobId}`)
      requireStatus(read, [200], 'File ingest poll')
      if (read.body?.status === 'done') {
        const fileId = read.body.fileId
        if (typeof fileId !== 'string' || read.body.jobId !== job.jobId) throw new Error('Completed ingest lost its job or file identity')
        const file = await fetch(`http://127.0.0.1:${port}/api/brain-inbox/${workspaceId}/workspace_file/${fileId}/content`, {
          headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000),
        })
        requireStatus(file, [200], 'Completed ingest file reopen')
        if (await file.text() !== source) throw new Error('Completed ingest file bytes changed')
        return { status: 'pass', jobId: job.jobId, fileId, completed: true, durableReopen: true }
      }
      if (read.body?.status === 'failed') return { status: 'fail', jobId: job.jobId, reason: 'Actual ingest worker reported failure' }
      await delay(500)
    }
    return { status: 'fail', jobId: job.jobId, reason: 'Actual ingest job did not complete in the bounded 90-second window' }
  }
  if (id === 'mailbox-tool-call') {
    if (!provider) return { status: 'not-yet-run', reason: 'The archive proof uses only the in-process deterministic provider' }
    return runMailboxArchiveProbe(context)
  }
  throw new Error(`Unknown runtime activation probe ${id}`)
}
