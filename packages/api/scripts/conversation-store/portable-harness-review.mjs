// Reviewed finite extension; never derive membership from a live catalog.
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'

export const harnessTables=Object.freeze([
 'project_harness_products','project_harness_components','project_harness_revisions',
 'project_harness_approvals','project_harness_runs','project_harness_evidence','project_harness_execution_audit',
])
export const harnessTriggerReview=Object.freeze({
 'project_harness_products.project_harness_product_parent':'update-only',
 'project_harness_components.project_harness_component_parent':'update-only',
 'project_harness_revisions.project_harness_revision_immutable':'update-delete-only',
 'project_harness_approvals.harness_approval_immutable':'update-delete-only',
 'project_harness_runs.harness_run_guard':'update-delete-only',
 'project_harness_runs.harness_run_audit':'suspended:derived-effect',
 'project_harness_evidence.harness_evidence_immutable':'update-delete-only',
 'project_harness_execution_audit.harness_audit_immutable':'update-delete-only',
})
// Opaque historical attribution, NOT a link to a restorable login capability.
export const harnessOpaqueAttribution=Object.freeze({
 project_harness_approvals:['auth_session_id'],project_harness_runs:['auth_session_id'],
})
export const reviewed8328RosterSha256='a12bf362ee1b87a1a0c18a77ebd7c4bb2cdfb612eac01b871664edfa4f412915'
export function harnessClassificationFrom8328(text){
 if(createHash('sha256').update(text).digest('hex')!==reviewed8328RosterSha256)
  throw Error('portable_harness_reviewed_baseline_changed')
 const baseline=JSON.parse(text)
 const tables=Object.entries(baseline.tables).map(([table,entry])=>({
  schema:'public',table,ownership:entry.class==='derived'?'installation_derived':'durable',
  generatedColumns:entry.generated??[],identityColumns:entry.identity??[],
  forceRls:Boolean(entry.forceRls),namedSlots:(entry.slots??[]).map(column=>({column})),
 }))
 for(const table of harnessTables)tables.push({schema:'public',table,ownership:'durable',
  generatedColumns:table==='project_harness_revisions'?['scope_id']:[],
  identityColumns:[],forceRls:false,namedSlots:[]})
 return {format:1,ledgerCount:807,tables:tables.sort((a,b)=>a.table.localeCompare(b.table))}
}
// Save this output as the explicit --inventory input BEFORE regenerating the
// head roster. After regeneration, supply the preserved reviewed 8328 bytes.
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const baseline=process.argv[2]??fileURLToPath(new URL('portable-restore-roster.json',import.meta.url))
 console.log(JSON.stringify(harnessClassificationFrom8328(await readFile(baseline,'utf8')),null,1))
}
