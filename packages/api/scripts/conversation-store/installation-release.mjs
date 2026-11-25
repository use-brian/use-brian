// [COMP:api/portable-restore] Select the exact source compiler for the active
// maintained release. Historical compiler modules remain immutable inputs.
import {fileURLToPath} from 'node:url'
import * as release8294 from './installation-authentication-8294.mjs'
import * as release8296 from './installation-authentication-8296.mjs'
import * as release8297 from './installation-authentication-8297.mjs'
import * as release8298 from './installation-authentication-8298.mjs'
import * as release8300 from './installation-authentication-8300.mjs'
import * as release8301 from './installation-authentication-8301.mjs'
import * as release8306 from './installation-authentication-8306.mjs'
import * as release8307 from './installation-authentication-8307.mjs'
import * as release8309 from './installation-authentication-8309.mjs'
import * as release8310 from './installation-authentication-8310.mjs'
import * as release8311 from './installation-authentication-8311.mjs'
import * as release8312 from './installation-authentication-8312.mjs'
import * as release8313 from './installation-authentication-8313.mjs'
import * as release8314 from './installation-authentication-8314.mjs'
import * as release8315 from './installation-authentication-8315.mjs'
import * as release8316 from './installation-authentication-8316.mjs'
import * as release8317 from './installation-authentication-8317.mjs'
import * as release8318 from './installation-authentication-8318.mjs'
import * as release8325 from './installation-authentication-8325.mjs'
import * as release8326 from './installation-authentication-8326.mjs'
import * as release8327 from './installation-authentication-8327.mjs'
import * as release8328 from './installation-authentication-8328.mjs'
import * as release8329 from './installation-authentication-8329.mjs'
import * as release8330 from './installation-authentication-8330.mjs'
import * as release8331 from './installation-authentication-8331.mjs'
import * as release8332 from './installation-authentication-8332.mjs'
import * as release8333 from './installation-authentication-8333.mjs'
import * as release8334 from './installation-authentication-8334.mjs'
import * as release8337 from './installation-authentication-8337.mjs'
import * as release8341 from './installation-authentication-8341.mjs'
import * as release8342 from './installation-authentication-8342.mjs'
import * as release8343 from './installation-authentication-8343.mjs'
import * as release8344 from './installation-authentication-8344.mjs'
import * as release8345 from './installation-authentication-8345.mjs'
import * as release8346 from './installation-authentication-8346.mjs'
import { indexedSearchRelease, searchCohortRelease } from './installation-authentication-8348.mjs'
import { telegramKnowledgeRelease } from './installation-authentication-8349.mjs'
import * as release8350 from './installation-authentication-8350.mjs'
import * as release8351 from './installation-authentication-8351.mjs'
import * as release8339 from './installation-authentication-8339.mjs'
import * as release8338 from './installation-authentication-8338.mjs'

const profiles=new Map([
 ['8294_fused_admission_plan_size.sql',release8294],
 ['8296_configured_task_publication.sql',release8296],
 ['8297_conversation_record_admission.sql',release8297],
 ['8298_legacy_bypass_retirement.sql',release8298],
 ['8300_conversation_record_conversion.sql',release8300],
 ['8301_conversation_receiving_owners.sql',release8301],
 ['8306_conversation_prompt_memory.sql',release8306],
 ['8307_conversation_record_floor.sql',release8307],
 ['8309_conversation_record_lineage.sql',release8309],
 ['8310_conversation_public_receiving.sql',release8310],
 ['8311_conversation_page_delivery.sql',release8311],
 ['8312_conversation_verified_channel_publication.sql',release8312],
 ['8313_conversation_page_publication.sql',release8313],
 ['8314_conversation_settings_readiness.sql',release8314],
 ['8315_conversation_retained_row_transitions.sql',release8315],
 ['8316_conversation_mixed_evidence_route.sql',release8316],
 ['8317_shared_room_resume_evidence.sql',release8317],
 ['8318_committed_room_record_evidence.sql',release8318],
 ['8325_conversation_office_observation.sql',release8325],
 ['8326_native_memory_query_write_contract.sql',release8326],
 ['8327_conversation_graph_set_verification.sql',release8327],
 ['8328_conversation_graph_frontier.sql',release8328],
 ['8329_conversation_memory_query_candidates.sql',release8329],
 ['8330_memory_prompt_candidates.sql',release8330],
 ['8331_workspace_mcp_dispatch.sql',release8331],
 ['8332_conversation_context_cost.sql',release8332],
 ['8333_workspace_files_prompt_catalog.sql',release8333],
 ['8334_conversation_publication_lock.sql',release8334],
 ['8337_project_chat_creation_admission.sql',release8337],
 ['8338_native_workspace_skill_receipts.sql',release8338],
 ['8339_knowledge_source_path_identity.sql',release8339],
 ['8341_crm_import_csv_index.sql',release8341],
 ['8342_memory_history_terminal_proof.sql',release8342],
 ['8343_conversation_capture_linear_aggregation.sql',release8343],
 ['8344_conversation_domain_source_aggregation.sql',release8344],
 ['8345_knowledge_query_scan_cost.sql',release8345],
 ['8346_knowledge_field_proof_batch.sql',release8346],
 [indexedSearchRelease.migration,indexedSearchRelease],
 [searchCohortRelease.migration,searchCohortRelease],
 [telegramKnowledgeRelease.migration,telegramKnowledgeRelease],
 ['8350_conversation_graph_ordinal_edges.sql',release8350],
 [release8351.migration,release8351],
])
export const hasInstallationRelease=head=>profiles.has(head)
function profileForRelease(head){
 const profile=profiles.get(head)
 if(!profile)throw Error('installation_unreviewed_release: '+head)
 return profile
}
export async function currentReleaseSource(head,options){
 const profile=profileForRelease(head),source=await profile.currentInstallationAuthenticationSource(options)
 return{...source,functions:source.functions??profile.currentFunctionCount}
}
export function releaseAuthentication(head,sourceRoot=fileURLToPath(new URL('../../',import.meta.url))){
 return client=>profileForRelease(head).authenticateConversationInstallation(client,{sourceRoot})
}
export async function authenticateConversationInstallation(client,options){
 if(client?.getTransactionStatus?.()!=='I')throw Error('installation_authentication_requires_idle_owner')
 const row=(await client.query('SELECT name FROM public._migrations ORDER BY name COLLATE "C" DESC LIMIT 1')).rows[0]
 return releaseAuthentication(row?.name,options?.sourceRoot)(client)
}
