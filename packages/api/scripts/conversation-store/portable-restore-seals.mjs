// [COMP:api/portable-restore] These fields prove a publication to its originating
// transaction only. The durable target ID, disposition, and receipt stay intact.
export const restoreStrippedFields=Object.freeze({
 episode_extraction_items:Object.freeze({
  configured_txid:'xid8',configured_backend_pid:'integer',configured_source:'jsonb',configured_task:'jsonb',
 }),
 conversation_envelopes:Object.freeze({
  record_conversion_generation:'bigint',record_conversion_revision:'bigint',record_conversion_through:'integer',record_conversion_legacy:'boolean',
 }),
})

// FORCE RLS remains enabled. The installed owner has a named ALL policy on
// these exact relations after the legacy setting is retired.
export const portableOwnerPolicies=Object.freeze({
 connector_pending_setups:'connector_setup_system',
 connector_rotation_attempts:'connector_rotation_attempts_system',
 connector_setup_auth_material:'connector_setup_auth_material_system',
 connector_setup_identity:'connector_setup_identity_system',
 connector_setup_rotation_receipts:'connector_setup_rotation_system',
 connector_setup_staged_credentials:'connector_setup_credentials_system',
})

// Restore legacy conversion units exactly. A record copy and the worker's
// cursor can be regenerated from the restored envelope and durable messages.
export const portableLegacyConversionTables=Object.freeze([
 'native_conversation_conversion_runs','native_conversation_conversion_pages',
 'native_conversation_conversion_inputs','native_conversation_conversion_pending',
])
const replaceableCompilers=`(
 encode(sha256(convert_to('native-conversation-record-conversion-v1','UTF8')),'hex'),
 encode(sha256(convert_to('native-conversation-record-enrollment-v1','UTF8')),'hex'))`
export function portableLegacyConversionPredicate(name,field){
 if(name==='native_conversation_conversion_runs')return field('compiler_digest')+' NOT IN '+replaceableCompilers
 if(name==='native_conversation_conversion_pages')return `EXISTS(SELECT 1 FROM public.native_conversation_conversion_runs r
  WHERE r.id=${field('run_id')} AND r.compiler_digest NOT IN ${replaceableCompilers})`
 if(name==='native_conversation_conversion_inputs'||name==='native_conversation_conversion_pending')
  return field('kind')+"::text<>'conversation_record'"
 throw new Error('portable_restore_unreviewed_record_projection: '+name)
}
