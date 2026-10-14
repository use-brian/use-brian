#!/usr/bin/env node
import {randomUUID} from 'node:crypto'
/** Observe-only hooks and inspectable setup. [COMP:engineering-capture/collector] */
import {readFile,realpath} from 'node:fs/promises'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {CollectorConfigSchema,setupPlan,scopeMatches,type CollectorConfig} from './setup.js'
import {projectCodexHook} from './providers/codex.js'
import {projectClaudeCodeHook} from './providers/claude-code.js'
import {CaptureSpool,CaptureLocalError} from './spool.js'
import {flushCapture} from './delivery.js'
const option=(args:string[],key:string)=>{const i=args.indexOf(`--${key}`);return i>=0?args[i+1]:undefined}
async function configuration(path:string){return CollectorConfigSchema.parse(JSON.parse(await readFile(path,'utf8')))}
async function stdin(){let text='';for await(const chunk of process.stdin){text+=chunk.toString();if(Buffer.byteLength(text)>1024*1024)throw new CaptureLocalError('hook_input_limit_exceeded')}return JSON.parse(text)}
function wake(configPath:string,config:CollectorConfig){
 const env:Record<string,string>={};for(const key of ['PATH','HOME','TMPDIR','LANG','LC_ALL',config.credentialEnv])if(process.env[key]!==undefined)env[key]=process.env[key]!
 const worker=spawn(process.execPath,[fileURLToPath(import.meta.url),'worker','--config',resolve(configPath)],{detached:true,stdio:'ignore',env});worker.unref()
}
export async function runCaptureCli(args:string[]){
 const [command]=args,configPath=option(args,'config')
 if(command==='setup'){
  const input=configPath?JSON.parse(await readFile(configPath,'utf8')):{version:1,provider:option(args,'provider'),endpoint:option(args,'endpoint'),credentialEnv:option(args,'credential-env'),project:option(args,'project'),sessionId:option(args,'session'),stateRoot:option(args,'state-root')}
  const existingPath=option(args,'existing-hooks'),existing=existingPath?JSON.parse(await readFile(existingPath,'utf8')):{}
  process.stdout.write(JSON.stringify(setupPlan(input,configPath??resolve('capture-config.example.json'),existing),null,2)+'\n');return
 }
 if(command==='hook'){
  let spool:CaptureSpool|undefined
  try{
   if(!configPath)throw new CaptureLocalError('capture_configuration_unavailable')
   const config=await configuration(configPath);if(config.project)config.project=await realpath(config.project)
   const input=await stdin(),observation=(config.provider==='codex'?projectCodexHook:projectClaudeCodeHook)(input)
   const x=input as Record<string,unknown>,sessionId=observation.sessionId??''
   if(typeof x.cwd!=='string'||!sessionId||!scopeMatches(config,await realpath(x.cwd),sessionId))return
   spool=new CaptureSpool(config);spool.diagnostic(observation)
   if(observation.event)spool.enqueue(observation.event)
   if(!args.includes('--no-wake'))wake(configPath,config)
  }catch(error){process.stderr.write(`brian-capture: ${error instanceof CaptureLocalError?error.code:'capture_hook_unavailable'}\n`)}
  finally{spool?.close();process.stdout.write('{}\n')}
  return
 }
 if(!configPath)throw new CaptureLocalError('capture_configuration_unavailable')
 const config=await configuration(configPath),spool=new CaptureSpool(config)
 try{
  if(command==='status'){process.stdout.write(JSON.stringify(spool.status(),null,2)+'\n');return}
  if(command==='flush'){if(args.includes('--accept-configuration'))spool.acceptConfiguration();if(args.includes('--resume'))spool.resume();process.stdout.write(JSON.stringify(await flushCapture(config,spool))+'\n');return}
  if(command==='worker'){
   const leaseToken=randomUUID();if(!spool.acquireLease(leaseToken))return
   const idleExitMs=Number(option(args,'idle-exit-ms')??3600000);let lastActivity=Date.now()
   while(Date.now()-lastActivity<idleExitMs){const result=await flushCapture(config,spool,undefined,100,leaseToken);if(!result.leased||result.suspended)break;if(result.delivered)lastActivity=Date.now();if(args.includes('--once'))break;await new Promise(r=>setTimeout(r,1000))}
   spool.releaseLease(leaseToken);return
  }
  throw new CaptureLocalError('capture_command_unknown')
 }finally{spool.close()}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))void runCaptureCli(process.argv.slice(2)).catch(error=>{
 process.stderr.write(`brian-capture: ${error instanceof CaptureLocalError?error.code:'capture_command_failed'}\n`);process.exitCode=1
})
