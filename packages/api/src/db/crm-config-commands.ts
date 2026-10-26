/** Canonical configuration composition over the R2 persistence helpers.
 * [COMP:crm/config-commands]
 */
import type { PoolClient } from 'pg'
import { actorAuditIdentity, assertCrmOperationsAuthority, canonicalCrmRequest, CrmOperationsError, CrmRecordFieldDefinitionSchema,
  type CrmConfigCommand, type CrmOperationsContext } from '@use-brian/core'
import {
  archiveCrmFieldDefinition, createCrmFieldDefinition, createCrmPipeline, createCrmStage,
  executeProtectedCrmConfiguration,lockCrmConfiguration, lockCrmConfigurationMember, restoreCrmFieldDefinition, setCrmStageArchived,
  updateCrmFieldDefinition, updateCrmPipeline, updateCrmStage,
} from './crm-r2.js'
import { authorizeCrmIntegrationCommand } from '../crm-operations/integration-authority.js'

type Saved = { record: Record<string, unknown>; created: boolean; changed: boolean; subjectKind: string }
type Row = Record<string, unknown> & { id: string; archivedAt: Date | null }
const FIELD = `id,entity_kind AS "entityKind",field_key AS "fieldKey",label,field_type AS "fieldType",
  options,is_required AS "isRequired",position,archived_at AS "archivedAt"`
const PIPELINE = 'id,name,is_default AS "isDefault",position,archived_at AS "archivedAt"'
const STAGE = `id,pipeline_id AS "pipelineId",name,legacy_key AS "legacyKey",category,position,
  probability,required_fields AS "requiredFields",archived_at AS "archivedAt"`
const missing = (): never => { throw new CrmOperationsError('not_found', 'The configuration item is unavailable in this workspace.') }
const conflict = (message: string, details: Record<string, unknown> = {}): never => { throw new CrmOperationsError('conflict', message, details) }
const record = (row: Row) => ({ ...row, archivedAt: row.archivedAt?.toISOString() ?? null })
function hasChange(row: Row, input: object, keys: string[]) {
  const fields = input as Record<string, unknown>
  return keys.some((key) => fields[key] !== undefined && canonicalCrmRequest(fields[key]) !== canonicalCrmRequest(row[key]))
}

export async function executeCrmConfigCommand(client: PoolClient, context: CrmOperationsContext, command: CrmConfigCommand): Promise<Saved> {
  try { return await compose(client, context, command) }
  catch (error) {
    const failure = error as { code?: string; constraint?: string }
    if (failure.code === '23505' && failure.constraint?.startsWith('crm_')) {
      conflict('Configuration conflicts with an existing item. Read the catalog and use an available key, name or position.', { reason: 'configuration_conflict' })
    }
    throw error
  }
}

async function compose(client: PoolClient, context: CrmOperationsContext, command: CrmConfigCommand): Promise<Saved> {
  assertCrmOperationsAuthority(context, command)
  if (context.authority.integration) await authorizeCrmIntegrationCommand(client, context, command)
  const workspaceId = context.workspaceId
  const userId = actorAuditIdentity(context.actor).actingUserId
  if (context.actor.kind !== 'integration_key') {
    await lockCrmConfigurationMember(client, workspaceId, userId)
  }
  const protectedResult=await executeProtectedCrmConfiguration(client,workspaceId,command,undefined,context.actor.kind==='assistant'?context.actor.assistantId:undefined)
  if(protectedResult)return protectedResult
  // Credential/member admission precedes the shared configuration/domain locks.
  await lockCrmConfiguration(client, workspaceId)
  const base = { workspaceId, userId, client }
  const read = async (table: string, columns: string, id: string): Promise<Row> => {
    const row = (await client.query<Row>(`SELECT ${columns} FROM ${table} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [workspaceId, id])).rows[0]
    return row ?? missing()
  }
  const finish = (row: Row | Record<string, unknown>, subjectKind: string, created = false, changed = true): Saved => ({ record: row, subjectKind, created, changed })
  const unique = async (table: string, predicate: string, values: unknown[]) => {
    const rows = (await client.query<{ id: string }>(`SELECT id FROM ${table} WHERE workspace_id=$1 AND ${predicate}`, [workspaceId, ...values])).rows
    if (rows.length) conflict('Configuration already exists. Read its current values before updating by id.', { reason: 'configuration_exists', ids: rows.map((row) => row.id) })
  }
  switch (command.kind) {
    case 'create_record_field': {
      await unique('crm_field_definitions', 'entity_kind=$2 AND field_key=$3', [command.entityKind, command.fieldKey])
      const saved = await createCrmFieldDefinition({ ...base, ...command })
      if (!saved) conflict('Custom field limit reached', { reason: 'field_limit' })
      return finish(saved!, 'record_field', true)
    }
    case 'update_record_field': {
      const before = await read('crm_field_definitions', FIELD, command.fieldId)
      if (before.archivedAt) conflict('Restore this field before changing its configuration.')
      if (command.options !== undefined) CrmRecordFieldDefinitionSchema.parse({ entityKind: before.entityKind, fieldKey: before.fieldKey,
        label: command.label ?? before.label, fieldType: before.fieldType, options: command.options ?? before.options,
        isRequired: command.isRequired ?? before.isRequired })
      if (!hasChange(before, command, ['label', 'options', 'isRequired'])) return finish(record(before), 'record_field', false, false)
      const saved = await updateCrmFieldDefinition({ ...base, ...command })
      return finish(saved ?? missing(), 'record_field')
    }
    case 'set_record_field_archived': {
      const before = await read('crm_field_definitions', FIELD, command.fieldId)
      if (Boolean(before.archivedAt) === command.archived) return finish(record(before), 'record_field', false, false)
      if (command.archived) await archiveCrmFieldDefinition(userId, workspaceId, command.fieldId, client)
      else await restoreCrmFieldDefinition(userId, workspaceId, command.fieldId, client)
      return finish(record(await read('crm_field_definitions', FIELD, command.fieldId)), 'record_field')
    }
    case 'create_pipeline': {
      await unique('crm_pipelines', 'name=$2 AND archived_at IS NULL', [command.name])
      const saved = await createCrmPipeline({ ...base, name: command.name })
      if (command.isDefault) await updateCrmPipeline({ ...base, pipelineId: saved.id, isDefault: true })
      return finish({ ...record(await read('crm_pipelines', PIPELINE, saved.id)), stages: [] }, 'pipeline', true)
    }
    case 'update_pipeline': {
      const before = await read('crm_pipelines', PIPELINE, command.pipelineId)
      if (command.isDefault === false && before.isDefault && command.archived !== true) {
        conflict('Select another default pipeline instead of removing the current default.')
      }
      if (before.archivedAt && command.isDefault === true && command.archived !== false) conflict('Restore this pipeline before making it the default.')
      const changed = hasChange(before, command, ['name', 'isDefault'])
        || (command.archived !== undefined && command.archived !== Boolean(before.archivedAt))
      if (changed) await updateCrmPipeline({ ...base, pipelineId: command.pipelineId,
        name: command.name !== before.name ? command.name : undefined,
        isDefault: command.isDefault !== before.isDefault ? command.isDefault : undefined,
        archived: command.archived !== Boolean(before.archivedAt) ? command.archived : undefined,
      })
      return finish(record(await read('crm_pipelines', PIPELINE, command.pipelineId)), 'pipeline', false, changed)
    }
    case 'create_pipeline_stage': {
      const parent = await read('crm_pipelines', PIPELINE, command.pipelineId)
      if (parent.archivedAt) conflict('Restore this pipeline before adding stages.')
      await unique('crm_pipeline_stages', 'pipeline_id=$2 AND name=$3 AND archived_at IS NULL', [command.pipelineId, command.name])
      return finish(await createCrmStage({ ...base, ...command }) ?? missing(), 'pipeline_stage', true)
    }
    case 'update_pipeline_stage': {
      const before = await read('crm_pipeline_stages', STAGE, command.stageId)
      if (command.archived === false) {
        const parent = await read('crm_pipelines', PIPELINE, String(before.pipelineId))
        if (parent.archivedAt) conflict('Restore the parent pipeline before restoring this stage.')
      }
      const metadata = hasChange(before, command, ['name', 'category', 'probability', 'requiredFields'])
      if (before.archivedAt && metadata && command.archived !== false) conflict('Restore this stage before changing its configuration.')
      const archive = command.archived !== undefined && command.archived !== Boolean(before.archivedAt)
      if (archive && command.archived === false) await setCrmStageArchived({ ...base, stageId: command.stageId, archived: false })
      if (metadata) await updateCrmStage({ ...base, ...command })
      if (archive && command.archived === true) await setCrmStageArchived({ ...base, stageId: command.stageId, archived: true })
      return finish(record(await read('crm_pipeline_stages', STAGE, command.stageId)), 'pipeline_stage', false, metadata || archive)
    }
  }
}
