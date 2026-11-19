// [COMP:api/portable-restore] Rehydrate CRM projections from portable facts.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { privateFile } from '../../../../scripts/operations/recovery-common.mjs'

export const crmSummaryProjectionRule = 'D10-crm-summary-projection'
export const crmSummaryCredentialRule = 'D11-crm-summary-credential'
export const crmSummaryDerivedRules = Object.freeze({
  crm_summary_entity_publications: crmSummaryProjectionRule,
  crm_summary_selected_cells: crmSummaryProjectionRule,
  crm_summary_rollup_leaves: crmSummaryProjectionRule,
  crm_summary_rollups: crmSummaryProjectionRule,
  crm_summary_attention_rollups: crmSummaryProjectionRule,
  crm_summary_company_references: crmSummaryProjectionRule,
  crm_summary_scope_policy_usage: crmSummaryProjectionRule,
  crm_summary_configuration_publications: crmSummaryProjectionRule,
  crm_summary_principal_revisions: crmSummaryProjectionRule,
  crm_summary_release_revisions: crmSummaryProjectionRule,
  crm_summary_receipt_keys: crmSummaryCredentialRule,
})
export const crmSummaryAuthorityEpochs = Object.freeze([
  'crm_summary_entity_domain_versions',
  'crm_summary_scope_partition_versions',
])
export const crmSummaryWriterHelpers = Object.freeze([
  'crm_summary_publish_partition_delta',
  'crm_summary_preserve_partition_leaf',
  'crm_summary_publish_rollup_leaf',
  'crm_summary_shift_scope_policy',
  'crm_summary_publish_configuration',
  'crm_summary_refresh_workspace_inputs',
])
export const crmSummaryStructuralValidators = Object.freeze([
  'crm_summary_guard_record_policy',
  'crm_summary_scope_policy_lock_record',
  'crm_summary_source_descriptor_guard',
])

export const crmSummaryOriginStamps = Object.freeze([
  'crm_summary_policy_adapters.crm_summary_guard_adapter',
  'crm_summary_policy_inputs.crm_summary_guard_policy_input',
  'crm_summary_policy_requirements.crm_summary_guard_policy_requirement',
])

const artifactName = 'crm-summary-credentials.enc'
const format = Buffer.from('BRIAN-CRM-CREDENTIALS-1\n')
const ivSize = 12
const tagSize = 16
const artifactLimit = 8 * 1024 * 1024
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const credentials = `SELECT id::text,encode(pad_inner,'hex') AS inner_pad,encode(pad_outer,'hex') AS outer_pad,
  issue_enabled,created_at::text FROM public.crm_summary_receipt_keys ORDER BY id`

export function crmSummaryPortable(roster) {
  const entries = Object.entries(crmSummaryDerivedRules)
  const present = entries.filter(([name]) => roster.tables[name] !== undefined)
  if (!present.length) return false
  if (present.length !== entries.length || present.some(([name, rule]) =>
    roster.tables[name].class !== 'derived' || roster.tables[name].rule !== rule)) {
    throw Error('portable_restore_crm_summary_roster_incomplete')
  }
  return true
}

function validateCredentialRows(rows) {
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
  const pad = /^[0-9a-f]{128}$/
  const timestamp = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?\+00\s*$/
  if (!Array.isArray(rows) || !rows.length || rows.filter(row => row?.issue_enabled === true).length !== 1
    || rows.some(row => Object.keys(row ?? {}).length !== 5 || !uuid.test(row.id) || !pad.test(row.inner_pad)
      || !pad.test(row.outer_pad) || typeof row.issue_enabled !== 'boolean' || !timestamp.test(row.created_at))
    || new Set(rows.map(row => row.id)).size !== rows.length) throw Error('portable_restore_crm_credentials_invalid')
}

export async function exportCrmSummaryCredentials(client, directory, key) {
  const { rows } = await client.query(credentials)
  validateCredentialRows(rows)
  const payload = Buffer.from(JSON.stringify(rows))
  if (payload.length > artifactLimit - format.length - ivSize - tagSize) throw Error('portable_restore_crm_credentials_too_large')
  const iv = randomBytes(ivSize)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(format)
  let bytes
  try {
    bytes = Buffer.concat([format, iv, cipher.update(payload), cipher.final(), cipher.getAuthTag()])
  } finally {
    payload.fill(0)
  }
  const path = join(directory, artifactName)
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } catch (cause) {
    await file.close()
    await rm(path, { force: true })
    throw cause
  }
  await file.close()
  return { file: artifactName, sha256: digest(bytes), records: rows.length }
}

export async function readCrmSummaryCredentials(directory, entry, key) {
  const invalid = () => Error('portable_restore_crm_credentials_untrusted')
  if (entry?.file !== artifactName || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')
    || !Number.isSafeInteger(entry.records) || entry.records < 1) throw invalid()
  try {
    const bytes = await privateFile(join(directory, artifactName), artifactLimit)
    if (bytes.length <= format.length + ivSize + tagSize || digest(bytes) !== entry.sha256
      || !bytes.subarray(0, format.length).equals(format)) throw invalid()
    const offset = format.length + ivSize
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(format.length, offset))
    decipher.setAAD(format)
    decipher.setAuthTag(bytes.subarray(-tagSize))
    // Parse only after GCM validates the entire artifact.
    const part = decipher.update(bytes.subarray(offset, -tagSize))
    let payload
    try {
      payload = Buffer.concat([part, decipher.final()])
      const rows = JSON.parse(payload.toString('utf8'))
      validateCredentialRows(rows)
      if (rows.length !== entry.records) throw invalid()
      return rows
    } finally {
      part.fill(0)
      payload?.fill(0)
    }
  } catch {
    throw invalid()
  }
}

export async function installCrmSummaryCredentials(client, rows) {
  validateCredentialRows(rows)
  await client.query('LOCK TABLE public.crm_summary_receipt_keys IN SHARE ROW EXCLUSIVE MODE')
  const { rows: [origin] } = await client.query(`SELECT count(*)=1 AND bool_and(issue_enabled)
    AND NOT EXISTS(SELECT 1 FROM public.crm_summary_source_descriptors) AS fresh FROM public.crm_summary_receipt_keys`)
  if (origin?.fresh !== true) return null
  await client.query('DELETE FROM public.crm_summary_receipt_keys')
  await client.query(`INSERT INTO public.crm_summary_receipt_keys(id,pad_inner,pad_outer,issue_enabled,created_at)
    SELECT id,decode(inner_pad,'hex'),decode(outer_pad,'hex'),issue_enabled,created_at FROM jsonb_to_recordset($1::jsonb)
    AS r(id uuid,inner_pad text,outer_pad text,issue_enabled boolean,created_at timestamptz)`, [JSON.stringify(rows)])
  if (JSON.stringify((await client.query(credentials)).rows) !== JSON.stringify(rows)) throw Error('portable_restore_crm_credential_digest_mismatch')
  return rows.length
}

export async function rebuildCrmSummaryProjections(client) {
  const tables = Object.entries(crmSummaryDerivedRules).filter(([, rule]) => rule === crmSummaryProjectionRule).map(([name]) => name)
  const live = tables.map(name => `EXISTS(SELECT 1 FROM public.${name})`).join(' OR ')
  const { rows: [state] } = await client.query('SELECT (' + live + ') AS populated')
  if (state?.populated !== false) throw Error('portable_restore_crm_projection_target_not_fresh')
  // The portable restore transaction already excludes every competing writer.
  // Use the projection owners, without invoking entity mutation triggers or
  // minting replacement historical partition generations.
  await client.query(`INSERT INTO public.crm_summary_release_revisions(workspace_id,revision)
    SELECT id,gen_random_uuid() FROM public.workspaces ORDER BY id`)
  await client.query(`SELECT public.crm_summary_publish_entity(e) FROM public.entities e
    WHERE e.workspace_id IS NOT NULL AND e.kind IN ('company','deal','person') ORDER BY e.workspace_id,e.id`)
  await client.query(`INSERT INTO public.crm_summary_selected_cells
    SELECT cells.* FROM public.crm_summary_entity_publications p
    JOIN public.entities e ON e.workspace_id=p.workspace_id AND e.id=p.entity_id
    CROSS JOIN LATERAL public.crm_summary_decode_selected_cells(e) cells`)
  const { rows: [partition] } = await client.query(`WITH expected AS (
    SELECT p.workspace_id,p.kind,p.scope_class_id,p.entity_id,p.record_version,public.crm_summary_selected_cells_digest(c) AS selected_digest
    FROM public.crm_summary_entity_publications p JOIN public.crm_summary_selected_cells c USING(workspace_id,entity_id,record_version)
    WHERE NOT EXISTS(SELECT 1 FROM public.scope_resource_states r WHERE r.workspace_id=p.workspace_id AND r.resource_kind='entity'
      AND r.resource_id=p.entity_id AND r.review_state='held')
  ), actual AS (
    SELECT workspace_id,kind,scope_class_id,entity_id,record_version,selected_digest FROM public.crm_summary_partition_leaves WHERE visible_until IS NULL
  ) SELECT EXISTS((SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL (SELECT * FROM actual EXCEPT SELECT * FROM expected)) AS changed`)
  if (partition?.changed !== false) throw Error('portable_restore_crm_partition_history_mismatch')
  await client.query(`SELECT public.crm_summary_publish_rollup_leaf(p.workspace_id,p.entity_id)
    FROM public.crm_summary_entity_publications p ORDER BY p.workspace_id,p.entity_id`)
  await client.query(`SELECT public.crm_summary_publish_configuration(w.id,coalesce(e.revision::text,'0'))
    FROM public.workspaces w LEFT JOIN public.application_native_crm_configuration_epochs e ON e.workspace_id=w.id ORDER BY w.id`)
  await client.query(`SELECT public.crm_summary_refresh_workspace_inputs(w.id,'all') FROM public.workspaces w ORDER BY w.id`)
  const counts = tables.map(name => `'${name}',(SELECT count(*) FROM public.${name})`).join(',')
  return (await client.query('SELECT jsonb_build_object(' + counts + ') AS projections')).rows[0].projections
}
