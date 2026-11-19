// [COMP:api/native-turn-frame] Reproduce the frozen source compiler profile.
// This reads source and runs a temporary compiler copy. No database is opened.
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {dirname,resolve,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {tmpdir} from 'node:os'
const args=process.argv.slice(2),option=(name,fallback)=>{const at=args.indexOf(name);return at<0?fallback:args[at+1]}
const directory=dirname(fileURLToPath(import.meta.url))+'/',root=resolve(option('--source-root',directory+'../../'))
const output=resolve(option('--output',directory+'conversion-predecessor-source.json')),file=join(root,'scripts/conversation-store/build-publication-recovery.mjs')
const sha=x=>createHash('sha256').update(x).digest('hex')
let code=await readFile(file,'utf8');const sourceSha=sha(code)
if(sourceSha!=='727ca3b1f55b9a02804df56ca9dea8b5b7da323f089bfed15ff326950e1beab0'||sha(await readFile(join(root,'migrations/8272_durable_conversation_publications.sql')))!=='06afd49b1e8a165f8cee9ec78ee5c4fa42ef815cdbfd192fa77f453025451609')throw Error('conversion_source_compiler_provenance_changed')
const originalURL=pathToFileURL(file).href,sourceDirectory=pathToFileURL(join(root,'scripts/conversation-store/')).href
code=code.replace("from './publication-recovery-source-order.mjs'",`from '${sourceDirectory}publication-recovery-source-order.mjs'`)
code=code.replace('createRequire(import.meta.url)',`createRequire(${JSON.stringify(originalURL)})`)
code=code.replace("await tsImport('../../src/session-kind.ts',import.meta.url)",`await tsImport(${JSON.stringify(join(root,'src/session-kind.ts'))},import.meta.url)`)
code=code.replace("const directory=new URL('./',import.meta.url),target=",`const directory=new URL(${JSON.stringify(sourceDirectory)}),target=`)
const marker="if(process.argv.includes('--source-specs'))",position=code.indexOf(marker)
if(position<0||code.indexOf(marker,position+1)!==-1)throw Error('conversion_source_export_seam_changed')
const temporary=await mkdtemp(join(tmpdir(),'brian-conversion-source-'))
try{
 const generated=join(temporary,'source.json')
 code=code.slice(0,position)+`await writeFile(${JSON.stringify(generated)},JSON.stringify({format:1,sourceSha:${JSON.stringify(sourceSha)},manifest,sourceSpecs,oldTableExpression,newTableExpression,oldRoster,nextRoster,authenticationPreamble:authentication.slice(0,authentication.indexOf('DO $authenticate$')),successorSource:await readFile(new URL('publication-recovery-successor.sql',directory),'utf8')},null,2));process.exit(0);\n`+code.slice(position)
 const module=join(temporary,'compile.mjs');await writeFile(module,code);await promisify(execFile)(process.execPath,[module])
 const profile=await readFile(generated)
 if(sha(profile)!=='70b820546a5e58a99030d531e6ac2ec9b8e87d344146b0acabbe95db997fa3ed')throw Error('conversion_source_profile_changed')
 if(args.includes('--check')){if(!(await readFile(output)).equals(profile))throw Error('conversion_source_profile_file_changed')}else await writeFile(output,profile)
}finally{await rm(temporary,{recursive:true,force:true})}
