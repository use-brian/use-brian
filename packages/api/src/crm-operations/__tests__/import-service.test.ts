import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrmOperationsContext, FilesApi } from '@use-brian/core'

const mocks = vi.hoisted(() => ({ query: vi.fn(), createContact: vi.fn(), updateContact: vi.fn() }))

vi.mock('../../db/client.js', () => ({ query: mocks.query }))
vi.mock('../../db/crm.js', () => ({
  createContact: mocks.createContact,
  createCompany: vi.fn(),
  createDeal: vi.fn(),
  updateContact: mocks.updateContact,
}))
vi.mock('../../db/crm-r2.js', () => ({ updateCrmCustomFields: vi.fn() }))
vi.mock('../../db/entities-store.js', () => ({ getEntityById: vi.fn(), updateEntity: vi.fn() }))

import { createCrmProductionImportService } from '../import-service.js'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const fileId = '33333333-3333-4333-8333-333333333333'
const jobId = '44444444-4444-4444-8444-444444444444'
const entityId = '55555555-5555-4555-8555-555555555555'
const source = 'Name,Email\nAda Example,ada@example.test\n'
const bytes = Buffer.from(source)
const sourceHash = createHash('sha256').update(bytes).digest('hex')

const context: CrmOperationsContext & { actor: { kind: 'user'; userId: string } } = {
  workspaceId,
  actor: { kind: 'user', userId },
  authority: { role: 'admin', canWrite: true, canConfigure: true, trustedIdentitySources: [] },
}

const readBytes = vi.fn(async () => ({ ok: true, value: { file: { id: fileId }, bytes } }))
const filesApi = { readBytes } as unknown as FilesApi
const operations = { execute: vi.fn() }

function job(status: 'ready' | 'paused' | 'completed', overrides: Record<string, unknown> = {}) {
  return {
    id: jobId,
    workspaceId,
    stagedFileId: fileId,
    entityKind: 'contact',
    status,
    mapping: { columns: { 0: 'name', 1: 'email' } },
    mappingHash: 'a'.repeat(64),
    sourceHash,
    totalRows: 1,
    processedRows: status === 'completed' ? 1 : 0,
    succeededRows: status === 'completed' ? 1 : 0,
    failedRows: 0,
    nextChunkIndex: status === 'completed' ? 1 : 0,
    createdByUserId: userId,
    createdAt: new Date('2026-08-30T00:00:00Z'),
    updatedAt: new Date('2026-08-30T00:00:00Z'),
    completedAt: status === 'completed' ? new Date('2026-08-30T00:01:00Z') : null,
    ...overrides,
  }
}

describe('[COMP:crm/production-import] production CRM import', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readBytes.mockResolvedValue({ ok: true, value: { file: { id: fileId }, bytes } })
    mocks.createContact.mockResolvedValue({ id: entityId })
    mocks.updateContact.mockResolvedValue({ id: entityId })
    operations.execute.mockResolvedValue({
      command: 'record_consent', record: {}, created: true, duplicate: false, emittedEventIds: [],
    })
  })

  it('dry-runs the full staged file without creating database rows', async () => {
    const service = createCrmProductionImportService({ filesApi, operations: operations as never })
    const result = await service.dryRun(context, {
      stagedFileId: fileId,
      entityKind: 'contact',
      mapping: { columns: { 0: 'name', 1: 'email' } },
    })

    expect(result).toMatchObject({ bytes: bytes.byteLength, totalRows: 1, validRows: 1, failedRows: 0 })
    expect(result.dryRunHash).toMatch(/^[0-9a-f]{64}$/)
    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.createContact).not.toHaveBeenCalled()
  })

  it('requires admin authority for a trusted identity mapping', async () => {
    const service = createCrmProductionImportService({ filesApi, operations: operations as never })
    await expect(service.dryRun({
      ...context,
      authority: { ...context.authority, role: 'member', canConfigure: false },
    }, {
      stagedFileId: fileId,
      entityKind: 'contact',
      mapping: { columns: { 0: 'name' }, trustedIdentitySource: 'shopify' },
    })).rejects.toThrow('owner or admin')
  })

  it('parses typed custom fields during dry run and rejects invalid values before commit', async () => {
    const invalidBytes = Buffer.from('Name,Score\nAda Example,not-a-number\n')
    readBytes.mockResolvedValueOnce({ ok: true, value: { file: { id: fileId }, bytes: invalidBytes } })
    mocks.query.mockResolvedValueOnce({
      rows: [{ fieldKey: 'score', fieldType: 'number', options: [] }],
    })
    const service = createCrmProductionImportService({ filesApi, operations: operations as never })
    const result = await service.dryRun(context, {
      stagedFileId: fileId,
      entityKind: 'contact',
      mapping: { columns: { 0: 'name', 1: 'custom:score' } },
    })

    expect(result).toMatchObject({ totalRows: 1, validRows: 0, failedRows: 1 })
    expect(result.sampleErrors).toEqual([
      expect.objectContaining({ code: 'invalid_custom_value', message: 'Number must be finite.' }),
    ])
    expect(mocks.createContact).not.toHaveBeenCalled()
  })

  it('commits one bounded chunk and treats a completed resume as a no-op', async () => {
    const service = createCrmProductionImportService({ filesApi, operations: operations as never })
    const checked = await service.dryRun(context, {
      stagedFileId: fileId,
      entityKind: 'contact',
      mapping: { columns: { 0: 'name', 1: 'email' } },
    })
    mocks.query.mockResolvedValueOnce({ rows: [job('ready')] })
    const confirmed = await service.confirm(context, {
      stagedFileId: fileId,
      entityKind: 'contact',
      mapping: { columns: { 0: 'name', 1: 'email' } },
      confirmed: true,
      dryRunHash: checked.dryRunHash,
    })
    expect(confirmed.status).toBe('ready')

    mocks.query
      .mockResolvedValueOnce({ rows: [job('ready')] }) // load
      .mockResolvedValueOnce({ rows: [{ id: jobId }] }) // claim
      .mockResolvedValueOnce({ rows: [{ id: 'chunk', status: 'running', inputHash: createHash('sha256').update(JSON.stringify([['Ada Example', 'ada@example.test']])).digest('hex') }] })
      .mockResolvedValueOnce({ rows: [] }) // receipt
      .mockResolvedValueOnce({ rows: [] }) // existing imported entity
      .mockResolvedValueOnce({ rows: [] }) // receipt insert
      .mockResolvedValueOnce({ rows: [] }) // chunk complete
      .mockResolvedValueOnce({ rows: [] }) // job complete
      .mockResolvedValueOnce({ rows: [job('completed')] })

    const completed = await service.resume(context, jobId)
    expect(completed.status).toBe('completed')
    expect(mocks.createContact).toHaveBeenCalledTimes(1)
    expect(mocks.createContact).toHaveBeenCalledWith(userId, expect.objectContaining({
      workspaceId,
      name: 'Ada Example',
      email: 'ada@example.test',
      externalRef: expect.objectContaining({ import_key: `${jobId}:2` }),
    }), undefined)

    mocks.query.mockResolvedValueOnce({ rows: [job('completed')] })
    await expect(service.resume(context, jobId)).resolves.toMatchObject({ status: 'completed' })
    expect(mocks.createContact).toHaveBeenCalledTimes(1)
  })

  it('matches a unique exact email only after admin confirms a trusted source', async () => {
    const mapping = {
      columns: { 0: 'name', 1: 'email' },
      trustedIdentitySource: 'verified_export',
    }
    const ready = job('ready', { mapping })
    const completed = job('completed', { mapping })
    mocks.query
      .mockResolvedValueOnce({ rows: [ready] })
      .mockResolvedValueOnce({ rows: [{ id: jobId }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'chunk', status: 'running',
        inputHash: createHash('sha256').update(JSON.stringify([['Ada Example', 'ada@example.test']])).digest('hex'),
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: entityId, attributes: { tags: ['existing'] } }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [completed] })

    const service = createCrmProductionImportService({ filesApi, operations: operations as never })
    await expect(service.resume(context, jobId)).resolves.toMatchObject({ status: 'completed' })
    expect(mocks.updateContact).toHaveBeenCalledWith(userId, entityId, expect.objectContaining({
      name: 'Ada Example', email: 'ada@example.test', tags: ['existing'],
      externalRef: expect.objectContaining({ import_key: `${jobId}:2` }),
    }), undefined)
    expect(mocks.createContact).not.toHaveBeenCalled()
  })

  it('uses deterministic provider event ids when a crashed operations row is replayed', async () => {
    const operationsSource = [
      'Contact ID,Purpose,Consent Action,Consent Source,Channel,Suppression Action,Reason,Suppression Source',
      `${entityId},updates,granted,legacy_export,email,suppressed,manual_do_not_contact,legacy_export`,
      '',
    ].join('\n')
    const operationsBytes = Buffer.from(operationsSource)
    const operationsHash = createHash('sha256').update(operationsBytes).digest('hex')
    const mapping = { columns: {
      0: 'contactId', 1: 'consentPurposeKey', 2: 'consentAction', 3: 'consentSource',
      4: 'suppressionChannel', 5: 'suppressionAction', 6: 'suppressionReasonCode', 7: 'suppressionSource',
    } }
    const ready = job('ready', { entityKind: 'operations', mapping, sourceHash: operationsHash })
    const completed = job('completed', { entityKind: 'operations', mapping, sourceHash: operationsHash })
    const cells = operationsSource.split('\n')[1]!.split(',')
    readBytes.mockResolvedValueOnce({ ok: true, value: { file: { id: fileId }, bytes: operationsBytes } })
    mocks.query
      .mockResolvedValueOnce({ rows: [ready] })
      .mockResolvedValueOnce({ rows: [{ id: jobId }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'chunk', status: 'running',
        inputHash: createHash('sha256').update(JSON.stringify([cells])).digest('hex'),
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [completed] })

    const service = createCrmProductionImportService({ filesApi, operations: operations as never })
    await expect(service.resume(context, jobId)).resolves.toMatchObject({ status: 'completed' })
    expect(operations.execute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      kind: 'record_consent', provider: 'import',
      providerEventId: `${jobId}:2:consent:updates`,
    }))
    expect(operations.execute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      kind: 'record_suppression', provider: 'import',
      providerEventId: `${jobId}:2:suppression:email`,
    }))
  })
})
