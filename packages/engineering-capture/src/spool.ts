/** Owner-only durable SQLite spool and cross-process lease. No credentials. */
import {DatabaseSync} from 'node:sqlite'
import {createHash,randomUUID} from 'node:crypto'
import {mkdirSync,lstatSync,chmodSync,existsSync,realpathSync} from 'node:fs'
import {resolve,dirname,join} from 'node:path'
import type {CollectorConfig} from './setup.js'
import type {Observation,SelectedEvent} from './providers/types.js'
export type SpoolEvent={id:string;ordinal:number;payload:Record<string,unknown>;attempts:number;status:string}
export class CaptureLocalError extends Error{constructor(readonly code:string,readonly retryable=false){super(code)}}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
export function connectionRef(config:CollectorConfig){return hash(JSON.stringify([config.endpoint,config.credentialEnv,config.provider]))}
function privateDirectory(path:string){
 if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new CaptureLocalError('spool_symlink_denied')
 mkdirSync(path,{recursive:true,mode:0o700})
 if(process.getuid&&lstatSync(path).uid!==process.getuid())throw new CaptureLocalError('spool_owner_mismatch')
 let p=realpathSync(path)
 while(true){if(existsSync(join(p,'.git')))throw new CaptureLocalError('spool_inside_repository');const parent=dirname(p);if(parent===p)break;p=parent}
 chmodSync(path,0o700)
}
export class CaptureSpool{
 private db:DatabaseSync
 readonly connection:string
 constructor(readonly config:CollectorConfig){
  privateDirectory(config.stateRoot);const path=join(resolve(config.stateRoot),'spool.sqlite')
  if(existsSync(path)&&(lstatSync(path).isSymbolicLink()||process.getuid&&lstatSync(path).uid!==process.getuid()))throw new CaptureLocalError('spool_owner_mismatch')
  const previous=process.umask(0o077)
  try{this.db=new DatabaseSync(path);chmodSync(path,0o600);this.db.exec(`PRAGMA busy_timeout=1500;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA secure_delete=ON;
   CREATE TABLE IF NOT EXISTS events(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,connection TEXT NOT NULL,partition TEXT NOT NULL,source_identity TEXT,source_digest TEXT,payload TEXT,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_ms INTEGER NOT NULL DEFAULT 0,receipt TEXT);
   CREATE TABLE IF NOT EXISTS metadata(connection TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS leases(connection TEXT PRIMARY KEY,token TEXT NOT NULL,expires_ms INTEGER NOT NULL);`)}finally{process.umask(previous)}
  this.connection=connectionRef(config)
 }
 close(){this.db.close()}
 private state():Record<string,unknown>{const r=this.db.prepare('SELECT value FROM metadata WHERE connection=?').get(this.connection) as {value:string}|undefined;return r?JSON.parse(r.value):{emitted:0,unobserved:0,failed:0}}
 updateState(patch:Record<string,unknown>){this.db.prepare('INSERT INTO metadata(connection,value) VALUES(?,?) ON CONFLICT(connection) DO UPDATE SET value=json_patch(metadata.value,excluded.value)').run(this.connection,JSON.stringify(patch))}
 diagnostic(observation:Observation){this.db.exec('BEGIN IMMEDIATE');try{const s=this.state();this.updateState({...(observation.diagnostic?{unobserved:Number(s.unobserved??0)+1,lastDiagnostic:observation.diagnostic}:{}),lastHookAt:new Date().toISOString()});this.db.exec('COMMIT')}catch(e){this.db.exec('ROLLBACK');throw e}}
 enqueue(event:SelectedEvent){
  this.db.exec('BEGIN IMMEDIATE')
  try{
   const partition=hash(JSON.stringify([this.connection,event.provider,event.sessionId])),id=event.sourceIdentity?hash(`${partition}:${event.sourceIdentity}`):randomUUID()
   const sourceDigest=hash(JSON.stringify([event.content,event.role,event.sessionId,event.turnId??null,event.attributionQuality]))
   const prior=this.db.prepare('SELECT id,source_digest FROM events WHERE id=?').get(id) as {id:string;source_digest:string}|undefined
   if(prior){if(prior.source_digest!==sourceDigest)throw new CaptureLocalError('source_event_conflict');this.db.exec('COMMIT');return prior.id}
   if(Buffer.byteLength(event.content)>this.config.maxEventBytes)throw new CaptureLocalError('event_limit_exceeded')
   const bound=this.db.prepare("SELECT count(*) AS n,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM events WHERE payload IS NOT NULL").get() as {n:number;bytes:number}
   const occurredAt=new Date().toISOString(),payload={captureMode:'routed',eventId:id,content:event.content,sessionId:event.sessionId,role:event.role,occurredAt,
    metadata:{provider:event.provider,attributionQuality:event.attributionQuality,timeQuality:'collector_observed',...(event.turnId?{turnId:event.turnId}:{})}}
   const encoded=JSON.stringify(payload)
   if(bound.n>=this.config.maxEvents||bound.bytes+Buffer.byteLength(encoded)>this.config.maxBytes)throw new CaptureLocalError('queue_limit_exceeded')
   this.db.prepare("INSERT INTO events(id,connection,partition,source_identity,source_digest,payload,status) VALUES(?,?,?,?,?,?,'pending')").run(id,this.connection,partition,event.sourceIdentity??null,sourceDigest,encoded)
   const s=this.state();this.updateState({emitted:Number(s.emitted??0)+1,lastHookAt:occurredAt});this.db.exec('COMMIT');return id
  }catch(e){this.db.exec('ROLLBACK');const s=this.state();this.updateState({failed:Number(s.failed??0)+1,lastFailure:e instanceof CaptureLocalError?e.code:'spool_unavailable'});throw e}
 }
 next(now=Date.now()):SpoolEvent|null{
  const row=this.db.prepare("SELECT id,ordinal,payload,attempts,status FROM events WHERE connection=? AND payload IS NOT NULL AND status='pending' ORDER BY ordinal LIMIT 1").get(this.connection) as {id:string;ordinal:number;payload:string;attempts:number;status:string}|undefined
  if(!row)return null
  const due=this.db.prepare('SELECT next_ms FROM events WHERE id=?').get(row.id) as {next_ms:number}
  return due.next_ms>now?null:{...row,payload:JSON.parse(row.payload)}
 }
 acquireLease(token:string,now=Date.now()){
  this.db.prepare('INSERT INTO leases(connection,token,expires_ms) VALUES(?,?,?) ON CONFLICT(connection) DO UPDATE SET token=excluded.token,expires_ms=excluded.expires_ms WHERE leases.expires_ms<? OR leases.token=excluded.token').run(this.connection,token,now+30000,now)
  return (this.db.prepare('SELECT token FROM leases WHERE connection=?').get(this.connection) as {token:string}).token===token
 }
 releaseLease(token:string){this.db.prepare('DELETE FROM leases WHERE connection=? AND token=?').run(this.connection,token)}
 accept(id:string,receipt:Record<string,unknown>){
  const terminal=['archived','excluded','deleted','dropped'].includes(String(receipt.deliveryStatus))
  const status=receipt.deliveryStatus==='archived'?'archived':terminal?'excluded':'pending'
  this.db.prepare('UPDATE events SET payload=CASE WHEN ? THEN NULL ELSE payload END,status=?,receipt=?,next_ms=? WHERE id=? AND connection=?').run(terminal?1:0,status,JSON.stringify(receipt),Math.max(Date.now()+5000,typeof receipt.firesAt==='string'?Date.parse(receipt.firesAt)+5000:0),id,this.connection)
  this.updateState({lastContactAt:new Date().toISOString(),...(terminal?{lastDeliveryAt:new Date().toISOString()}:{})})
 }
 fail(id:string,code:string,permanent=false){
  const row=this.db.prepare('SELECT attempts FROM events WHERE id=?').get(id) as {attempts:number},attempts=row.attempts+1
  const status=permanent||attempts>=this.config.maxRetries?'failed':'pending'
  this.db.prepare('UPDATE events SET attempts=?,status=?,next_ms=? WHERE id=? AND connection=?').run(attempts,status,Date.now()+Math.min(300000,1000*2**Math.min(attempts,9)),id,this.connection)
  this.updateState({lastFailure:code,...(permanent||status==='failed'?{suspended:true}:{})})
 }
 configurationFingerprint(value:string){const prior=this.state().configurationFingerprint;if(prior&&prior!==value)throw new CaptureLocalError('capture_configuration_changed');this.updateState({configurationFingerprint:value,lastContactAt:new Date().toISOString()})}
 acceptConfiguration(){this.updateState({configurationFingerprint:null})}
 resume(){this.db.prepare("UPDATE events SET status='pending',attempts=0,next_ms=0 WHERE connection=? AND payload IS NOT NULL AND status='failed'").run(this.connection);this.updateState({suspended:false})}
 status():Record<string,unknown>&{counts:Record<string,number>;localEmitterObserved:boolean;noWorkInference:boolean}{const rows=this.db.prepare('SELECT status,count(*) AS n FROM events WHERE connection=? GROUP BY status').all(this.connection) as {status:string;n:number}[];return {...this.state(),counts:Object.fromEntries(rows.map(r=>[r.status,r.n])),localEmitterObserved:Boolean(this.state().lastHookAt),noWorkInference:false}}
}
