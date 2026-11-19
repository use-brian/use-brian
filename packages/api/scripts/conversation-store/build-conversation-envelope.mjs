// [COMP:api/conversation-visibility] Forward-only ordinary foundation. The one
// session-kind classifier owns both pure and SQL privacy classification.
import {readFile,writeFile,readdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {conversationVisibilityClassificationSql} from '../../src/session-kind.ts'
const directory=fileURLToPath(new URL('./',import.meta.url))
const target=directory+'../../migrations/8295_conversation_envelope_foundation.sql'
const template=await readFile(directory+'conversation-envelope.sql','utf8')
const marker='/* CONVERSATION_VISIBILITY_CLASSIFICATION */'
if(template.split(marker).length!==2)throw Error('conversation_envelope_classification_slot_changed')
const sql=template.replace(marker,conversationVisibilityClassificationSql('s',{
 historical:'historical',workspace:'w',provenLegacyGroup:'legacy_group',currentMember:'member_now'}))
const names=(await readdir(directory+'../../migrations')).filter(name=>/^\d{4}_.*\.sql$/.test(name))
if(names.some(name=>Number(name.slice(0,4))>8295)||names.some(name=>name.startsWith('8295_')&&!target.endsWith(name)))
 throw Error('conversation_envelope_migration_number_changed')
if(process.argv.includes('--check')){
 if(await readFile(target,'utf8')!==sql)throw Error('conversation_envelope_generated_migration_changed')
 console.log('Conversation envelope source matches')
}else{await writeFile(target,sql);console.log('Wrote conversation envelope foundation')}
