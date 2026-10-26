import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
/** Build existing SDK browser graph and two static applications. No dependency installation. */
import { cp, mkdir, readFile, writeFile,symlink } from 'node:fs/promises'
import { resolve, dirname,join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../..')
const destination = resolve(process.argv[2] ?? resolve(root, 'output/application-platform/reference-web'))
if (destination === here || here.startsWith(destination + '/') || destination.startsWith(root + '/') && !destination.startsWith(resolve(root,'output') + '/')) throw new Error('Output must be separate from sources')
await mkdir(destination, { recursive: true })
for (const directory of ['operations','portal','shared','service-bot','external-source']) await cp(resolve(here,directory),resolve(destination,directory),{recursive:true,filter: source => !/\.(test\.mjs|ts)$/.test(source)})
await mkdir(resolve(destination,'sdk'),{recursive:true})
for (const file of ['application.js','transport.js','sign-in.js']) {
 const bytes = await readFile(resolve(root,'packages/brian-app/dist',file),'utf8')
 if (/from ['"](?:node:|@use-brian\/(?:core|shared))/.test(bytes)) throw new Error('Unsafe browser runtime import')
 await writeFile(resolve(destination,'sdk',file),bytes)
}
await writeFile(resolve(destination,'index.html'),'<!doctype html><html lang="en"><title>Brian application references</title><a href="operations/">Operations</a> <a href="portal/">Customer portal</a></html>\n')
const kit = resolve(destination,'node_modules/@use-brian/brian-app')
await mkdir(kit,{recursive:true})
await cp(resolve(root,'packages/brian-app/dist'),resolve(kit,'dist'),{recursive:true})
await cp(resolve(root,'packages/brian-app/package.json'),resolve(kit,'package.json'))
console.log('Built operations and portal static frontends plus separate Node source/service profiles')

// Optional fixed server artifact; never shipped to the browser directory.
if(process.argv.includes('--module')){
 const server=resolve(root,'output/application-platform/reference-module'),source=resolve(server,'source'),modules=resolve(server,'node_modules')
 await mkdir(source,{recursive:true});await mkdir(resolve(modules,'@use-brian'),{recursive:true});await mkdir(resolve(modules,'@types'),{recursive:true})
 await writeFile(resolve(server,'package.json'),JSON.stringify({type:'module'}))
 for(const file of ['module.ts','configuration.ts','host.ts'])await cp(resolve(here,'operations',file),resolve(source,file))
 const require=createRequire(resolve(root,'packages/api/package.json'))
 for(const name of ['api','core','shared','brian-app'])try{await symlink(resolve(root,'packages',name),resolve(modules,'@use-brian',name),'dir')}catch(error){if(error.code!=='EEXIST')throw error}
 for(const name of ['node','pg'])try{await symlink(dirname(require.resolve('@types/'+name+'/package.json')),resolve(modules,'@types',name),'dir')}catch(error){if(error.code!=='EEXIST')throw error}
 const compiler=createRequire(resolve(root,'packages/brian-app/package.json')).resolve('typescript/bin/tsc')
 execFileSync(process.execPath,[compiler,'--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--strict','--skipLibCheck','--declaration','--rootDir',source,'--outDir',resolve(server,'dist'),...['module.ts','configuration.ts','host.ts'].map(file=>resolve(source,file))],{cwd:server,stdio:'inherit',timeout:300000})
 console.log('Built fixed purchase module JavaScript/declarations at '+resolve(server,'dist'))
}
