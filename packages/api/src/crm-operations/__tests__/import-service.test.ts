import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrmOperationsContext, FilesApi } from '@use-brian/core'
import { CrmOperationsError } from '@use-brian/core'

const mocks = vi.hoisted(() => ({ query: vi.fn(), createContact: vi.fn(), updateContact: vi.fn(),
  transactionQuery: vi.fn(), connect: vi.fn(), release: vi.fn(), applyRLSGucs: vi.fn(), lockCredential: vi.fn(), readCredential: vi.fn() }))

vi.mock('../../db/client.js', () => {const pool={
  // Department scope probes see a legacy workspace; v2 import floors are proven against real PostgreSQL.
  query: async (sql: string) => sql.includes('department_read_v2 AS v2') ? { rows: [{ v2: false }] } : { rows: [] },
  connect: async () => { const connectionId = mocks.connect.mock.calls.length; mocks.connect(connectionId); return {
  release: () => mocks.release(connectionId),
  query: async (sql: string, values: unknown[]) => {
    const intercepted = await mocks.transactionQuery(sql, values, connectionId)
    if (intercepted !== undefined) return intercepted
    if (sql.startsWith('SELECT id,created_by_user_id AS "userId",')) return { rows: [{ userId: '22222222-2222-4222-8222-222222222222', active: true }] }
    if(sql.includes('pg_catalog.pg_roles'))return Promise.resolve({rows:[{bypass:false}]})
    if(sql.includes("nullif(current_setting('app.current_user_id'"))return Promise.resolve({rows:[{userId:'22222222-2222-4222-8222-222222222222'}]})
    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT)/.test(sql) || sql.includes("set_config('app.system_bypass'") || sql.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [] })
    if (sql.startsWith('SELECT 1 FROM workspace_modules WHERE workspace_id=$1 AND module_key=$2 FOR SHARE')) return Promise.resolve({ rows: [] })
    if (sql.startsWith('SELECT id FROM workspaces WHERE id=$1 AND department_read_v2 FOR UPDATE')) return Promise.resolve({ rows: [] })
    if (sql.includes('SELECT role FROM workspace_members')) return Promise.resolve({ rows: [{ role: 'admin' }] })
    return mocks.query(sql, values)
  },
} } };return {query:mocks.query,getPool:()=>pool,getAppPool:()=>pool,applyRLSGucs:mocks.applyRLSGucs} })
vi.mock('../../db/crm-integration-store.js', () => ({ lockCrmIntegrationCredential: mocks.lockCredential, readCrmIntegrationCredential: mocks.readCredential }))
vi.mock('../../db/crm-reader.js',()=>({queryLegacyCanonicalCrmSql:async(_access:unknown,_templates:unknown,sql:string,values:unknown[],client:{query:(sql:string,values:unknown[])=>Promise<unknown>})=>client.query(sql,values)}))
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
const confirmationKey = '66666666-6666-4666-8666-666666666666'
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
    sourceId: null,
    integrationCredentialId: null,
    integrationGrants: null,
    entityKind: 'contact',
    status,
    privacyErased: false,
    privacyErasedAt: null,
    mapping: { columns: { 0: 'name', 1: 'email' } },
    mappingHash: 'a'.repeat(64),
    sourceHash,
    confirmationKey: null,
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
    vi.resetAllMocks()
    readBytes.mockResolvedValue({ ok: true, value: { file: { id: fileId }, bytes } })
    mocks.createContact.mockResolvedValue({ id: entityId })
    mocks.updateContact.mockResolvedValue({ id: entityId })
    operations.execute.mockResolvedValue({
      command: 'record_consent', record: { id: entityId }, created: true, duplicate: false, emittedEventIds: [],
    })
  })

  function cancellationService(overrides: Parameters<typeof createCrmProductionImportService>[0] = {
    operationsForTransaction: () => operations as never,
  }) {
    let cancelled = false
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM crm_import_jobs WHERE')) return { rows: [job('ready', {
        status: cancelled ? 'cancelled' : 'ready',
      })] }
      if (sql.includes("UPDATE crm_import_jobs SET status='cancelled'")) cancelled = true
      return { rows: [] }
    })
    return createCrmProductionImportService(overrides)
  }
  const admissionSql = 'SELECT id FROM workspaces WHERE id=$1 AND department_read_v2 FOR UPDATE'
  const credentialPrecheckSql = 'SELECT id,created_by_user_id AS "userId",'
  const statementTimeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })

  it.each(['module', 'workspace'])('retries one rolled-back %s admission wait with fresh job and member checks', async (gate) => {
    const service = cancellationService()
    const trace: string[] = []
    mocks.connect.mockImplementation((id: number) => trace.push(`connect:${id}`))
    mocks.release.mockImplementation((id: number) => trace.push(`release:${id}`))
    const selectedGate = gate === 'workspace' ? admissionSql
      : 'SELECT 1 FROM workspace_modules WHERE workspace_id=$1 AND module_key=$2 FOR SHARE'
    mocks.transactionQuery.mockImplementation(async (sql: string, _values: unknown[], connectionId: number) => {
      trace.push(`${connectionId}:${sql}`)
      if (connectionId === 0 && sql === selectedGate) throw statementTimeout()
    })
    const originalContext = structuredClone(context)
    await expect(service.cancel(context, jobId)).resolves.toMatchObject({ id: jobId, status: 'cancelled' })
    expect(context).toEqual(originalContext)
    expect(mocks.connect).toHaveBeenCalledTimes(2)
    expect(mocks.release.mock.calls).toEqual([[0], [1]])
    expect(trace.indexOf('release:0')).toBeLessThan(trace.indexOf('connect:1'))
    const secondMemberChecks = mocks.transactionQuery.mock.calls.filter(([sql, , id]) => id === 1 && String(sql).includes('SELECT role FROM workspace_members'))
    expect(secondMemberChecks).toHaveLength(2)
    const secondCalls = mocks.transactionQuery.mock.calls.filter(([, , id]) => id === 1).map(([sql]) => String(sql))
    expect(secondCalls.findIndex((sql) => sql.includes('SELECT role FROM workspace_members'))).toBeLessThan(secondCalls.indexOf(admissionSql))
    const secondMemberSql = secondCalls.filter((sql) => sql.includes('SELECT role FROM workspace_members'))
    expect(secondMemberSql[0]).not.toContain('FOR SHARE')
    expect(secondMemberSql[1]).toContain('FOR SHARE')
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes('FROM crm_import_jobs WHERE'))).toHaveLength(4)
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes("UPDATE crm_import_jobs SET status='cancelled'"))).toHaveLength(1)
    expect(mocks.transactionQuery.mock.calls.filter(([sql]) => sql === 'ROLLBACK')).toHaveLength(1)
    expect(mocks.transactionQuery.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(1)
    expect(mocks.applyRLSGucs.mock.calls.every(([, actor]) => actor === userId)).toBe(true)
    expect(operations.execute).not.toHaveBeenCalled()
  })

  it('stops after a second admission timeout and exposes that original database error', async () => {
    const service = cancellationService()
    const errors = [statementTimeout(), statementTimeout()]
    mocks.transactionQuery.mockImplementation(async (sql: string, _values: unknown[], id: number) => {
      if (sql === admissionSql) throw errors[id]
    })
    await expect(service.cancel(context, jobId)).rejects.toBe(errors[1])
    expect(mocks.connect).toHaveBeenCalledTimes(2)
    expect(mocks.release).toHaveBeenCalledTimes(2)
    expect(mocks.transactionQuery.mock.calls.filter(([sql]) => sql === 'ROLLBACK')).toHaveLength(2)
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes("UPDATE crm_import_jobs SET status='cancelled'"))).toHaveLength(0)
  })

  it.each([
    ['57014', 'canceling statement due to user request'],
    ['57014', 'another database cancellation'],
    ['57015', 'canceling statement due to statement timeout'],
  ])('does not retry admission failure %s with message %s', async (code, message) => {
    const service = cancellationService()
    const error = Object.assign(new Error(message), { code })
    mocks.transactionQuery.mockImplementation(async (sql: string) => { if (sql === admissionSql) throw error })
    await expect(service.cancel(context, jobId)).rejects.toBe(error)
    expect(mocks.connect).toHaveBeenCalledTimes(1)
    expect(mocks.release).toHaveBeenCalledTimes(1)
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes("UPDATE crm_import_jobs SET status='cancelled'"))).toHaveLength(0)
  })

  it('does not retry an admission timeout when rollback cannot be confirmed', async () => {
    const service = cancellationService()
    const error = statementTimeout()
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql === admissionSql) throw error
      if (sql === 'ROLLBACK') throw new Error('Connection lost during rollback.')
    })
    await expect(service.cancel(context, jobId)).rejects.toBe(error)
    expect(mocks.connect).toHaveBeenCalledTimes(1)
    expect(mocks.release).toHaveBeenCalledTimes(1)
    expect(mocks.transactionQuery.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(0)
  })

  it.each(['business', 'commit', 'member'])('does not retry a statement timeout during %s', async (phase) => {
    const service = cancellationService()
    const error = statementTimeout()
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (phase === 'business' && sql.includes("UPDATE crm_import_jobs SET status='cancelled'")
        || phase === 'commit' && sql === 'COMMIT'
        || phase === 'member' && sql.includes('SELECT role FROM workspace_members')) throw error
    })
    await expect(service.cancel(context, jobId)).rejects.toBe(error)
    expect(mocks.connect).toHaveBeenCalledTimes(1)
    expect(mocks.release).toHaveBeenCalledTimes(1)
    expect(mocks.transactionQuery.mock.calls.filter(([sql]) => sql === 'ROLLBACK')).toHaveLength(1)
  })

  it('refuses revoked membership before the second blocking admission', async () => {
    const service = cancellationService()
    mocks.transactionQuery.mockImplementation(async (sql: string, _values: unknown[], id: number) => {
      if (id === 0 && sql === admissionSql) throw statementTimeout()
      if (id === 1 && sql.includes('SELECT role FROM workspace_members')) return { rows: [] }
    })
    await expect(service.cancel(context, jobId)).rejects.toMatchObject({ code: 'not_authorized' })
    expect(mocks.connect).toHaveBeenCalledTimes(2)
    expect(mocks.transactionQuery.mock.calls.filter(([sql, , id]) => id === 1 && sql === admissionSql)).toHaveLength(0)
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes("UPDATE crm_import_jobs SET status='cancelled'"))).toHaveLength(0)
  })

  it('rechecks job visibility before connecting for the fresh cancellation attempt', async () => {
    const service = cancellationService()
    mocks.query.mockResolvedValueOnce({ rows: [job('ready')] }).mockResolvedValueOnce({ rows: [] })
    mocks.transactionQuery.mockImplementation(async (sql: string) => { if (sql === admissionSql) throw statementTimeout() })
    await expect(service.cancel(context, jobId)).rejects.toMatchObject({ code: 'not_found' })
    expect(mocks.connect).toHaveBeenCalledTimes(1)
    expect(mocks.release).toHaveBeenCalledTimes(1)
    expect(mocks.transactionQuery.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(0)
  })

  it('refuses a changed key issuer instead of substituting an actor on retry', async () => {
    const issuer = vi.fn().mockResolvedValueOnce({ rows: [{ userId }] })
      .mockResolvedValueOnce({ rows: [{ userId: entityId }] })
    const service = cancellationService({ operationsForTransaction: () => operations as never, pool: { query: issuer } as never })
    mocks.transactionQuery.mockImplementation(async (sql: string) => { if (sql === admissionSql) throw statementTimeout() })
    const keyContext: CrmOperationsContext = { ...context, actor: { kind: 'integration_key', credentialId: confirmationKey },
      authority: { ...context.authority, integration: { credentialId: confirmationKey,
        grants: [{ operation: 'crm.imports.write', selectors: {} }] } } }
    await expect(service.cancel(keyContext, jobId)).rejects.toMatchObject({ code: 'not_authorized' })
    expect(issuer).toHaveBeenCalledTimes(2)
    expect(mocks.connect).toHaveBeenCalledTimes(1)
    expect(mocks.lockCredential).not.toHaveBeenCalled()
    expect(mocks.applyRLSGucs.mock.calls.every(([, actor]) => actor === userId)).toBe(true)
  })

  it.each(['missing', 'revoked', 'expired', 'issuer'])('refuses %s key metadata before a repeated blocking admission', async (state) => {
    const issuer = vi.fn().mockResolvedValue({ rows: [{ userId }] })
    const service = cancellationService({ operationsForTransaction: () => operations as never, pool: { query: issuer } as never })
    mocks.transactionQuery.mockImplementation(async (sql: string, _values: unknown[], id: number) => {
      if (id === 0 && sql === admissionSql) throw statementTimeout()
      if (id === 1 && sql.startsWith(credentialPrecheckSql)) return { rows: state === 'missing' ? []
        : [{ userId: state === 'issuer' ? entityId : userId, active: state === 'issuer' }] }
    })
    const keyContext: CrmOperationsContext = { ...context, actor: { kind: 'integration_key', credentialId: confirmationKey },
      authority: { ...context.authority, integration: { credentialId: confirmationKey,
        grants: [{ operation: 'crm.imports.write', selectors: {} }] } } }
    await expect(service.cancel(keyContext, jobId)).rejects.toMatchObject({ code: 'not_authorized' })
    expect(mocks.readCredential).not.toHaveBeenCalled()
    expect(mocks.lockCredential).not.toHaveBeenCalled()
    expect(mocks.transactionQuery.mock.calls.filter(([sql, , id]) => id === 1 && sql === admissionSql)).toHaveLength(0)
    expect(mocks.release.mock.calls).toEqual([[0], [1]])
  })

  it.each(['member', 'key'])('retains locked %s renewal after a successful refusal-only retry precheck', async (actor) => {
    const issuer = vi.fn().mockResolvedValue({ rows: [{ userId }] })
    const service = cancellationService({ operationsForTransaction: () => operations as never, pool: { query: issuer } as never })
    mocks.transactionQuery.mockImplementation(async (sql: string, _values: unknown[], id: number) => {
      if (id === 0 && sql === admissionSql) throw statementTimeout()
      if (actor === 'member' && id === 1 && sql.includes('SELECT role FROM workspace_members') && sql.includes('FOR SHARE')) return { rows: [] }
    })
    const grants = [{ operation: 'crm.imports.write' as const, selectors: {} }]
    mocks.lockCredential.mockRejectedValue(new CrmOperationsError('credential_revoked', 'Credential revoked after precheck.'))
    const current: CrmOperationsContext = actor === 'member' ? context
      : { ...context, actor: { kind: 'integration_key', credentialId: confirmationKey },
        authority: { ...context.authority, integration: { credentialId: confirmationKey, grants } } }
    await expect(service.cancel(current, jobId)).rejects.toMatchObject({ code: 'not_authorized' })
    expect(mocks.connect).toHaveBeenCalledTimes(2)
    expect(mocks.transactionQuery.mock.calls.filter(([sql, , id]) => id === 1 && sql === admissionSql)).toHaveLength(1)
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes("UPDATE crm_import_jobs SET status='cancelled'"))).toHaveLength(0)
    if (actor === 'key') {
      expect(mocks.readCredential).not.toHaveBeenCalled()
      expect(mocks.lockCredential).toHaveBeenCalledTimes(1)
      const secondQueries = mocks.transactionQuery.mock.calls.filter(([, , id]) => id === 1).map(([sql]) => String(sql))
      expect(secondQueries.findIndex((sql) => sql.startsWith(credentialPrecheckSql))).toBeLessThan(secondQueries.indexOf(admissionSql))
      expect(secondQueries.find((sql) => sql.startsWith(credentialPrecheckSql))).not.toMatch(/FOR (SHARE|UPDATE)/)
    }
    expect(mocks.release.mock.calls).toEqual([[0], [1]])
  })

  it('admits an independent current key only after full locked renewal and commit renewal', async () => {
    const issuer = vi.fn().mockResolvedValue({ rows: [{ userId }] })
    const service = cancellationService({ operationsForTransaction: () => operations as never, pool: { query: issuer } as never })
    const grants = [{ operation: 'crm.imports.write' as const, selectors: {} }]
    let cancelled = false
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM crm_import_jobs WHERE')) return { rows: [job('ready', {
        stagedFileId: null, sourceId: entityId, integrationCredentialId: confirmationKey,
        integrationGrants: grants, status: cancelled ? 'cancelled' : 'ready',
      })] }
      if (sql.includes("UPDATE crm_import_jobs SET status='cancelled'")) cancelled = true
      return { rows: [] }
    })
    mocks.transactionQuery.mockImplementation(async (sql: string, _values: unknown[], id: number) => {
      if (id === 0 && sql === admissionSql) throw statementTimeout()
    })
    mocks.lockCredential.mockImplementation(async () => {
      expect(mocks.transactionQuery.mock.calls.filter(([sql, , id]) => id === 1 && sql === admissionSql)).toHaveLength(1)
      return { workspaceId, credentialId: confirmationKey, grants }
    })
    const current: CrmOperationsContext = { ...context, actor: { kind: 'integration_key', credentialId: confirmationKey },
      authority: { ...context.authority, integration: { credentialId: confirmationKey, grants } } }
    await expect(service.cancel(current, jobId)).resolves.toMatchObject({ status: 'cancelled' })
    expect(mocks.readCredential).not.toHaveBeenCalled()
    expect(mocks.lockCredential).toHaveBeenCalledTimes(2)
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes("UPDATE crm_import_jobs SET status='cancelled'"))).toHaveLength(1)
    expect(mocks.release.mock.calls).toEqual([[0], [1]])
  })

  it('dry-runs the full staged file without creating database rows', async () => {
    const service = createCrmProductionImportService({ filesApi, operationsForTransaction: () => operations as never })
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
    const service = createCrmProductionImportService({ filesApi, operationsForTransaction: () => operations as never })
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
    const service = createCrmProductionImportService({ filesApi, operationsForTransaction: () => operations as never })
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

  it('validates explicit historical participation imports during dry run', async () => {
    const service = createCrmProductionImportService({ filesApi, operationsForTransaction: () => operations as never })
    for (const [historical, validRows] of [['true', 1], ['false', 1], ['yes', 0]] as const) {
      readBytes.mockResolvedValueOnce({ ok: true, value: { file: { id: fileId }, bytes: Buffer.from(
        `Contact,Event,Source,Name,Historical\n${entityId},${fileId},fixture-row,Fictional attendee,${historical}\n`,
      ) } })
      const result = await service.dryRun(context, { stagedFileId: fileId, entityKind: 'operations',
        mapping: { columns: { 0: 'contactId', 1: 'participationEventId', 2: 'participationSourceId', 3: 'participantName', 4: 'participationHistoricalImport' } },
      })
      expect(result.validRows).toBe(validRows)
      if (!validRows) expect(result.sampleErrors).toContainEqual(expect.objectContaining({ code: 'invalid_historical_import' }))
    }
  })

  it('preflights a standalone digest-only promotion row and has no plaintext-code target', async () => {
    const columns = [
      'promotionSource', 'promotionSite', 'promotionId', 'promotionKey', 'promotionName',
      'promotionCodeDigest', 'promotionDiscountType', 'promotionPercentageBasisPoints',
      'promotionAmountMinor', 'promotionCurrency', 'promotionBuyQuantity', 'promotionGetQuantity',
      'promotionTargetKind', 'promotionTargetIdsJson',
      'promotionRecurrenceMode', 'promotionRecurrenceCycles', 'promotionApplyMode',
      'promotionMaxUses', 'promotionMaxUsesPerContact',
      'promotionCombinesWithMemberPrice', 'promotionReleaseOnFullRefund', 'promotionStatus',
      'promotionSourceRedeemedUses', 'promotionSourceContactUsesJson',
    ]
    const row = [
      'wix', 'oasahk.org', 'coupon-1', 'member-ten', 'Member 10%', 'a'.repeat(64),
      'percentage', '1000', '', '', '', '', 'event', JSON.stringify([fileId]), 'once', '', 'each_eligible_item', '20', '2', 'false', 'false',
      'active', '2', JSON.stringify([{ contactId: entityId, uses: 2 }]),
    ]
    const cell = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
    const promotionBytes = Buffer.from(`${columns.join(',')}\n${row.map(cell).join(',')}\n`)
    readBytes.mockResolvedValueOnce({ ok: true, value: { file: { id: fileId }, bytes: promotionBytes } })
    const service = createCrmProductionImportService({ filesApi, operationsForTransaction: () => operations as never })
    const input = { stagedFileId: fileId, entityKind: 'operations' as const,
      mapping: { columns: Object.fromEntries(columns.map((column, index) => [index, column])) } }
    await expect(service.dryRun(context, input)).resolves.toMatchObject({ totalRows: 1, validRows: 1, failedRows: 0 })
    await expect(service.dryRun(context, {
      ...input,
      mapping: { columns: { ...input.mapping.columns, [columns.length]: 'promotionCode' } },
    })).rejects.toThrow('unknown import target')

    const incomplete = [...row]
    incomplete[columns.indexOf('promotionSourceContactUsesJson')] = '[]'
    readBytes.mockResolvedValueOnce({ ok: true, value: { file: { id: fileId }, bytes: Buffer.from(
      `${columns.join(',')}\n${incomplete.map(cell).join(',')}\n`,
    ) } })
    await expect(service.dryRun(context, input)).resolves.toMatchObject({ totalRows: 1, validRows: 0, failedRows: 1,
      sampleErrors: [expect.objectContaining({ code: 'invalid_promotion' })] })
  })

  it('preflights source membership lineage without accepting provider renewal authority', async () => {
    const columns = [
      'contactId', 'entitlementPlanId', 'entitlementIdempotencyKey', 'entitlementStatus',
      'entitlementStartsAt', 'entitlementEndsAt', 'entitlementRenewalMode',
      'sourceMembershipSource', 'sourceMembershipSite', 'sourceMembershipId',
      'sourceMembershipPlanId', 'sourceMembershipSubscriptionId',
      'sourceMembershipPaymentProvider', 'sourceMembershipPaymentReference',
      'sourceMembershipStatus', 'sourceMembershipRenewalStatus',
      'sourceMembershipPurchasedAt', 'sourceMembershipRelationshipsJson',
    ]
    const row = [
      entityId, fileId, 'wix-membership:source-1', 'active',
      '2026-08-01T00:00:00Z', '2027-08-01T00:00:00Z', 'none',
      'wix', 'oasahk_org', 'source-1', 'plan-1', 'subscription-1',
      'stripe', 'sub_source_1', 'ACTIVE', 'AUTO_RENEWING',
      '2026-08-01T00:00:00Z', JSON.stringify({ companyId: 'company-1' }),
    ]
    const cell = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
    const membershipBytes = Buffer.from(`${columns.join(',')}\n${row.map(cell).join(',')}\n`)
    readBytes.mockResolvedValueOnce({ ok: true, value: { file: { id: fileId }, bytes: membershipBytes } })
    const service = createCrmProductionImportService({ filesApi, operationsForTransaction: () => operations as never })
    const input = { stagedFileId: fileId, entityKind: 'operations' as const,
      mapping: { columns: Object.fromEntries(columns.map((column, index) => [index, column])) } }
    await expect(service.dryRun(context, input)).resolves.toMatchObject({ totalRows: 1, validRows: 1, failedRows: 0 })
    row[columns.indexOf('entitlementRenewalMode')] = 'auto'
    readBytes.mockResolvedValueOnce({ ok: true, value: { file: { id: fileId }, bytes: Buffer.from(
      `${columns.join(',')}\n${row.map(cell).join(',')}\n`,
    ) } })
    await expect(service.dryRun(context, input)).resolves.toMatchObject({ totalRows: 1, validRows: 0, failedRows: 1,
      sampleErrors: [expect.objectContaining({ code: 'invalid_source_membership' })] })
  })

  it('commits one bounded chunk and treats a completed resume as a no-op', async () => {
    const service = createCrmProductionImportService({ filesApi, operationsForTransaction: () => operations as never })
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
      .mockResolvedValueOnce({ rows: [job('ready')] }) // source snapshot
      .mockResolvedValueOnce({ rows: [job('ready')] }) // locked load
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
    }), undefined, expect.objectContaining({ client: expect.anything(), afterCommit: expect.any(Function) }))
    const receiptInsert = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO crm_import_rows'))
    expect(receiptInsert?.[1]).toEqual([
      workspaceId, jobId, 2, expect.stringMatching(/^[0-9a-f]{64}$/), entityId,
      JSON.stringify([{ kind: 'contact', id: entityId }]),
    ])

    mocks.query.mockResolvedValueOnce({ rows: [job('completed')] }).mockResolvedValueOnce({ rows: [job('completed')] })
    await expect(service.resume(context, jobId)).resolves.toMatchObject({ status: 'completed' })
    expect(mocks.createContact).toHaveBeenCalledTimes(1)
  })

  it('returns the original job for an exact confirmation replay and rejects changed input', async () => {
    const service = createCrmProductionImportService({ filesApi, operationsForTransaction: () => operations as never })
    const input = {
      stagedFileId: fileId,
      entityKind: 'contact' as const,
      mapping: { columns: { 0: 'name', 1: 'email' } },
    }
    const checked = await service.dryRun(context, input)
    const replay = job('ready', {
      confirmationKey,
      mappingHash: createHash('sha256').update(JSON.stringify({
        columns: { 0: 'name', 1: 'email' }, trustedIdentitySource: null,
      })).digest('hex'),
    })
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [replay] })
    await expect(service.confirm(context, {
      ...input, confirmed: true, dryRunHash: checked.dryRunHash, confirmationKey,
    })).resolves.toMatchObject({ id: jobId, status: 'ready' })
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain('ON CONFLICT (workspace_id,confirmation_key)')

    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ ...replay, sourceHash: 'b'.repeat(64) }],
    })
    await expect(service.confirm(context, {
      ...input, confirmed: true, dryRunHash: checked.dryRunHash, confirmationKey,
    })).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('matches a unique exact email only after admin confirms a trusted source', async () => {
    const mapping = {
      columns: { 0: 'name', 1: 'email' },
      trustedIdentitySource: 'verified_export',
    }
    const ready = job('ready', { mapping })
    const completed = job('completed', { mapping })
    mocks.query
      .mockResolvedValueOnce({ rows: [ready] }) // source snapshot
      .mockResolvedValueOnce({ rows: [ready] }) // locked load
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

    const service = createCrmProductionImportService({ filesApi, operationsForTransaction: () => operations as never })
    await expect(service.resume(context, jobId)).resolves.toMatchObject({ status: 'completed' })
    expect(mocks.updateContact).toHaveBeenCalledWith(userId, entityId, expect.objectContaining({
      name: 'Ada Example', email: 'ada@example.test', tags: ['existing'],
      externalRef: expect.objectContaining({ import_key: `${jobId}:2` }),
    }), undefined, expect.objectContaining({ workspaceId }), expect.anything(), undefined, expect.any(Function))
    expect(mocks.createContact).not.toHaveBeenCalled()
  })

  it.each([undefined, '2026-01-01T03:00:00.123456+03:00'])('preserves evidence time %s and deterministic ids when an operations row is replayed', async (occurredAt) => {
    const operationsSource = [
      'Contact ID,Purpose,Consent Action,Consent Source,Channel,Suppression Action,Reason,Suppression Source,Consent Time,Suppression Time',
      `${entityId},updates,granted,legacy_export,email,suppressed,manual_do_not_contact,legacy_export,${occurredAt ?? ''},${occurredAt ?? ''}`,
      '',
    ].join('\n')
    const operationsBytes = Buffer.from(operationsSource)
    const operationsHash = createHash('sha256').update(operationsBytes).digest('hex')
    const mapping = { columns: {
      0: 'contactId', 1: 'consentPurposeKey', 2: 'consentAction', 3: 'consentSource',
      4: 'suppressionChannel', 5: 'suppressionAction', 6: 'suppressionReasonCode', 7: 'suppressionSource',
      8: 'consentOccurredAt', 9: 'suppressionOccurredAt',
    } }
    const ready = job('ready', { entityKind: 'operations', mapping, sourceHash: operationsHash })
    const completed = job('completed', { entityKind: 'operations', mapping, sourceHash: operationsHash })
    const cells = operationsSource.split('\n')[1]!.split(',')
    readBytes.mockResolvedValueOnce({ ok: true, value: { file: { id: fileId }, bytes: operationsBytes } })
    mocks.query
      .mockResolvedValueOnce({ rows: [ready] }) // source snapshot
      .mockResolvedValueOnce({ rows: [ready] }) // locked load
      .mockResolvedValueOnce({ rows: [{ id: jobId }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'chunk', status: 'running',
        inputHash: createHash('sha256').update(JSON.stringify([cells])).digest('hex'),
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [completed] })

    const service = createCrmProductionImportService({ filesApi, operationsForTransaction: () => operations as never })
    await expect(service.resume(context, jobId)).resolves.toMatchObject({ status: 'completed' })
    expect(operations.execute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      kind: 'record_consent', provider: 'import',
      providerEventId: `${jobId}:2:consent:updates`,
    }))
    expect(operations.execute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      kind: 'record_suppression', provider: 'import',
      providerEventId: `${jobId}:2:suppression:email`,
    }))
    for (const [, command] of operations.execute.mock.calls) {
      if (occurredAt) expect(command).toHaveProperty('occurredAt', occurredAt)
      else expect(command).not.toHaveProperty('occurredAt')
    }
    const receiptInsert = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO crm_import_rows'))
    expect(JSON.parse(String(receiptInsert?.[1]?.[5]))).toEqual([
      { kind: 'contact', id: entityId },
      { kind: 'consent', id: entityId },
      { kind: 'suppression', id: entityId },
    ])
  })

  it('exports ordered result receipts after checking read authority', async () => {
    const service = createCrmProductionImportService({ filesApi, operationsForTransaction: () => operations as never })
    mocks.query
      .mockResolvedValueOnce({ rows: [job('completed')] })
      .mockResolvedValueOnce({ rows: [{
        rowNumber: 2, status: 'completed', inputHash: 'b'.repeat(64),
        resultRefs: [{ kind: 'contact', id: entityId }],
      }] })
    await expect(service.resultsCsv(context, jobId)).resolves.toBe([
      'row,status,input_hash,result_refs',
      `2,completed,${'b'.repeat(64)},"[{""kind"":""contact"",""id"":""${entityId}""}]"`,
    ].join('\r\n'))
  })

  it.each(['consentOccurredAt', 'suppressionOccurredAt'])('validates %s in preflight without discarding invalid historical evidence', async (target) => {
    const isConsent = target === 'consentOccurredAt'
    const columns = isConsent
      ? ['contactId', 'consentPurposeKey', 'consentAction', 'consentSource', target]
      : ['contactId', 'suppressionChannel', 'suppressionAction', 'suppressionReasonCode', 'suppressionSource', target]
    const base = isConsent ? [entityId, 'updates', 'granted', 'fixture']
      : [entityId, 'email', 'released', 'manual_do_not_contact', 'fixture']
    const times = ['2026-01-01T03:00:00.123456+03:00', '', '2026-01-01', '2026-01-01T00:00:00', '2026-02-30T00:00:00Z', 'not-a-time', '2026-01-01T00:00:00.1234567Z']
    const rows = times.map((at) => [...base, at].join(','))
    rows.push([entityId, ...base.slice(1).map(() => ''), times[0]].join(','))
    readBytes.mockResolvedValueOnce({ ok: true, value: { file: { id: fileId }, bytes: Buffer.from([columns.join(','), ...rows, ''].join('\n')) } })
    const service = createCrmProductionImportService({ filesApi, operationsForTransaction: () => operations as never })
    const result = await service.dryRun(context, { stagedFileId: fileId, entityKind: 'operations',
      mapping: { columns: Object.fromEntries(columns.map((column, index) => [index, column])) } })
    expect(result).toMatchObject({ totalRows: 8, validRows: 2, failedRows: 6 })
    expect(result.sampleErrors.filter((error) => error.code === 'invalid_instant')).toHaveLength(5)
    expect(result.sampleErrors).toContainEqual(expect.objectContaining({ row: 9, code: isConsent ? 'incomplete_consent' : 'incomplete_suppression' }))
    expect(operations.execute).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
  })
})
