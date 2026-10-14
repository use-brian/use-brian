/** Inspectable local opt-in plan; Brian remains the routing registry. */
import {resolve,relative,isAbsolute} from 'node:path'
import {homedir} from 'node:os'
import {z} from 'zod'
export const CollectorConfigSchema=z.object({version:z.literal(1),provider:z.enum(['codex','claude-code']),endpoint:z.string().url(),credentialEnv:z.string().regex(/^[A-Z][A-Z0-9_]*$/),
 project:z.string().optional(),sessionId:z.string().min(1).max(200).optional(),stateRoot:z.string().default(resolve(homedir(),'.usebrian','engineering-capture')),
 expectedProcessingPurpose:z.literal('archive_only').default('archive_only'),maxEvents:z.number().int().min(1).max(10000).default(1000),maxBytes:z.number().int().min(1024).max(1024*1024*1024).default(64*1024*1024),
 maxEventBytes:z.number().int().min(1).max(256*1024).default(256*1024),maxRetries:z.number().int().min(1).max(50).default(12),
}).strict().superRefine((v,c)=>{if(!v.project&&!v.sessionId)c.addIssue({code:'custom',message:'Explicit project or session opt-in required'});const u=new URL(v.endpoint);if(u.username||u.password||u.search||u.hash||!['http:','https:'].includes(u.protocol))c.addIssue({code:'custom',message:'Endpoint must not contain credentials or query parameters'});if(u.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(u.hostname))c.addIssue({code:'custom',message:'Remote endpoint requires HTTPS'})})
export type CollectorConfig=z.infer<typeof CollectorConfigSchema>
export function scopeMatches(config:CollectorConfig,cwd:string,sessionId:string){
 if(config.sessionId&&config.sessionId!==sessionId)return false
 if(config.project){const r=relative(resolve(config.project),resolve(cwd));if(r==='..'||r.startsWith(`..${process.platform==='win32'?'\\':'/'}`)||isAbsolute(r))return false}
 return true
}
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'"
export function setupPlan(input:unknown,configPath:string,existing:Record<string,unknown>={}){
 const config=CollectorConfigSchema.parse(input),command=`brian-capture hook --config ${quote(resolve(configPath))}`
 const selected=config.provider==='codex'?['SessionStart','UserPromptSubmit','Stop','Interrupt','SessionEnd']:['SessionStart','UserPromptSubmit','Stop','StopFailure','SessionEnd']
 const hooks={...((existing.hooks&&typeof existing.hooks==='object')?existing.hooks as Record<string,unknown>:{})}
 for(const event of selected){const prior=Array.isArray(hooks[event])?hooks[event] as unknown[]:[];const entry={hooks:[{type:'command',command,timeout:3}]}
  hooks[event]=[...prior.filter(x=>JSON.stringify(x)!==JSON.stringify(entry)),entry]}
 return {config,hookConfiguration:{...existing,hooks},configPath:resolve(configPath),workerCommand:`brian-capture worker --config ${quote(resolve(configPath))}`,
  instructions:['Save the inspected configuration outside repositories.','Merge only these entries with existing provider hooks.','Review and trust the hooks through the provider’s normal trust flow.','Hooks queue locally and wake a leased delivery worker. No coding decisions or model context are returned.','Run brian-capture status to inspect local emitter and server delivery independently.'],
  coverage:{protocol:'documented-hook-fields-v1',humanOrigin:'unverified',sourceReplay:config.provider==='codex'?'turn identity when supplied':'no documented immutable identity; distinct submissions retained',liveInstallationVerified:false}}
}
