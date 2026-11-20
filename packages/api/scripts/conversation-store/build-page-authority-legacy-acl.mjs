// [COMP:api/migration-owner-role] Maintained CLI, source-owned ordered prerequisite.
import {readFile,writeFile} from 'node:fs/promises'
import {pageAuthorityLegacyAclSql} from './page-authority-legacy-acl.mjs'
const output=new URL('../../migrations/82775_legacy_page_authority_privileges.sql',import.meta.url)
const args=process.argv.slice(2)
if(args.length>1||args.some(arg=>!['--check','--print'].includes(arg)))throw Error('Use --check, --print, or no argument')
if(args[0]==='--print')process.stdout.write(pageAuthorityLegacyAclSql)
else if(args[0]==='--check'){
 if(await readFile(output,'utf8')!==pageAuthorityLegacyAclSql)throw Error('Page authority prerequisite needs regeneration')
 console.log('Page authority prerequisite matches reviewed source')
}else{await writeFile(output,pageAuthorityLegacyAclSql);console.log('Generated82775_legacy_page_authority_privileges.sql')}
