// [COMP:api/migration-owner-role] Source-known legacy system setting retirement.
import {readFile,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import {currentInstallationAuthenticationSource} from './installation-authentication-8297.mjs'
import {executableProjection} from './executable-record.mjs'
import {witnessRelationCheckSql} from './registry-guard-successor.mjs'
import {assertLegacyBypassRetiredSql,bypassContextRendererSql,bypassFusedCaptureSql,bypassOrdinaryFunctionsSql,fusedCaptureSignature,legacyBypassContextFunctions} from './legacy-bypass-functions.mjs'

const dir=fileURLToPath(new URL('./',import.meta.url)),root=resolve(dir+'../../')
const q=value=>"'"+value.replaceAll("'","''")+"'"
const replaceOnce=(source,part,next)=>{
 if(source.split(part).length!==2)throw Error('legacy_bypass_compiler_shape_changed: '+part.slice(0,80))
 return source.replace(part,()=>next)
}

export const bypassMigrationName='8298_legacy_bypass_retirement.sql'
export async function buildLegacyBypassRetirement(){
const source=await currentInstallationAuthenticationSource({sourceRoot:root})
const prefix='a8297_',rendererName='bypass_successor_source_body'
const input=name=>readFile(dir+name,'utf8')
const [policies,admission,installer,currentConsumers]=await Promise.all([
 input('legacy-bypass-policies.sql'),input('legacy-bypass-admission-policy.sql'),
 input('conversion-install.mjs'),input('conversion-original-consumers.sql'),
])
const ordinary=bypassOrdinaryFunctionsSql(root)
const consumers=replaceOnce(currentConsumers,"WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()');",
 `WHERE signature IN(${legacyBypassContextFunctions.filter(([signature])=>signature!==fusedCaptureSignature).map(([signature])=>q(signature)).join(',')});`)
 .replaceAll('publication_expected_current',prefix+'publication_expected_current')
 .replaceAll('publication_successor_templates',prefix+'publication_successor_templates')
 .replaceAll('conversion_affected_functions','bypass_affected_functions')
 .replaceAll('$conversion_original_consumers$','$bypass_original_consumers$')

const start='DO $conversion_propagate$',end='END $conversion_propagate$;'
if(installer.split(start).length!==2||installer.split(end).length!==2)throw Error('legacy_bypass_propagation_source_changed')
let propagate=installer.slice(installer.indexOf(start),installer.indexOf(end)+end.length)
 .replaceAll('publication_expected_current',prefix+'publication_expected_current')
 .replaceAll('publication_successor_templates',prefix+'publication_successor_templates')
 .replaceAll('pg_temp.conversion_source_body','pg_temp.'+rendererName)
 .replaceAll('$conversion_propagate$','$bypass_propagate$')
propagate=replaceOnce(propagate,'SET contract=after_row','SET contract='+executableProjection('after_row'))
propagate=replaceOnce(propagate,'p IS DISTINCT FROM h.contract',executableProjection('p')+' IS DISTINCT FROM h.contract')

return `-- [COMP:api/migration-owner-role] Remove the reviewed system connection setting from the policy and executable catalog.
BEGIN;
DO $legacy_bypass_prerequisites$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'legacy_bypass_unreviewed_ddl_trigger';END IF;
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='8297_conversation_record_admission.sql') THEN RAISE EXCEPTION 'legacy_bypass_predecessor_missing';END IF;
END $legacy_bypass_prerequisites$;
${source.sql}
${ordinary.inventory}
${ordinary.auth}
${consumers}
${policies}
${admission}
${ordinary.install}
${bypassContextRendererSql(rendererName,prefix+'conversion_source_body')}
${propagate}
${bypassFusedCaptureSql(prefix)}
${assertLegacyBypassRetiredSql}
DO $legacy_bypass_record$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE THEN RAISE EXCEPTION 'legacy_bypass_witness_record_failed';END IF;
END $legacy_bypass_record$;
${witnessRelationCheckSql('bypass_')}
${source.cleanup}
DROP FUNCTION pg_temp.${rendererName}(text,jsonb,boolean);
COMMIT;
`
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const [mode,path]=process.argv.slice(2)
 if(!['--candidate','--check','--write-numbered'].includes(mode)||(mode==='--candidate')!==Boolean(path))
  throw Error('Use --candidate PATH, --check or --write-numbered')
 const output=path?resolve(path):resolve(root,'migrations',bypassMigrationName)
 const sql=await buildLegacyBypassRetirement()
 if(mode==='--check'){
  if(await readFile(output,'utf8')!==sql)throw Error('legacy_bypass_numbered_source_changed')
 }else await writeFile(output,sql,{mode:0o600,...(mode==='--write-numbered'?{flag:'wx'}:{})})
 console.log(mode==='--check'?'Verified generated legacy bypass migration':'Generated legacy bypass migration',output)
}
