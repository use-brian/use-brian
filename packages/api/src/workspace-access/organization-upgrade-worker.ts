/** Background setup maintenance. [COMP:api/organization-upgrade-worker] */
import {getPool} from '../db/client.js'
import {completeOrganizationUpgrade} from './organization-cutover.js'
import {WorkspaceAccessError} from './policy.js'

const INTERVAL_MS=60_000
const BATCH_SIZE=5

/** Durable discovery includes workspaces created after deployment. No user read
 * or browser mount is a prerequisite. Backoff keeps blocked tenants from
 * starving later workspaces; the cutover itself serializes competing workers. */
export async function runOrganizationUpgrades(signal?:AbortSignal) {
 const pool=getPool()
 await pool.query(`INSERT INTO workspace_organization_upgrade_jobs(workspace_id)
  SELECT w.id FROM workspaces w LEFT JOIN workspace_access_policies p ON p.workspace_id=w.id
  WHERE w.department_read_v2 AND coalesce(p.setup_state,'legacy')='legacy'
    AND coalesce(p.access_mode,'departments')='departments'
  ON CONFLICT(workspace_id) DO NOTHING`)
 const {rows}=await pool.query<{workspace_id:string;attempts:number;diagnostics:unknown[]}>(`SELECT workspace_id,attempts,diagnostics
  FROM workspace_organization_upgrade_jobs WHERE status<>'completed' AND next_attempt_at<=clock_timestamp()
  ORDER BY next_attempt_at,workspace_id LIMIT $1`,[BATCH_SIZE])
 for(const row of rows) {
  if(signal?.aborted)break
  let status='blocked',diagnostics:unknown[]=[]
  try {
   const result=await completeOrganizationUpgrade(row.workspace_id)
   if(result.status==='applied'||result.status==='already_ready')status='completed'
   else diagnostics=result.status==='blocked'?result.blockers:[{code:result.status}]
  }catch(error) {
   // Do not store SQL messages, content, credentials or model-generated prose.
   diagnostics=[{code:error instanceof WorkspaceAccessError?error.code:'organization_upgrade_failed'}]
  }
  if(status==='blocked'&&JSON.stringify(row.diagnostics??[])!==JSON.stringify(diagnostics)) {
   console.warn('[organization-upgrade] operations attention; retry scheduled',row.workspace_id,diagnostics)
  }
  const delay=Math.min(30*60_000,INTERVAL_MS*2**Math.min(row.attempts,5))
  await pool.query(`UPDATE workspace_organization_upgrade_jobs SET attempts=attempts+1,
   status=$2,diagnostics=$3::jsonb,last_attempt_at=clock_timestamp(),
   next_attempt_at=clock_timestamp()+($4::double precision*interval '1 millisecond')
   WHERE workspace_id=$1 AND status<>'completed'`,[row.workspace_id,status,JSON.stringify(diagnostics),delay])
 }
}

export function createOrganizationUpgradeWorker(options:{run?:(signal:AbortSignal)=>Promise<void>;intervalMs?:number;onError?:(error:unknown)=>void}={}) {
 const run=options.run??runOrganizationUpgrades
 const onError=options.onError??((error:unknown)=>console.error('[organization-upgrade] worker failed',error))
 let timer:ReturnType<typeof setInterval>|undefined
 let inFlight:Promise<void>|undefined
 let stopped=false
 let abort=new AbortController()
 const tick=():Promise<void>=>{
  if(stopped)return Promise.resolve()
  if(inFlight)return inFlight
  inFlight=Promise.resolve().then(()=>run(abort.signal)).catch(onError).finally(()=>{inFlight=undefined})
  return inFlight
 }
 return {
  tick,
  start(){if(timer)return;stopped=false;abort=new AbortController();timer=setInterval(()=>void tick(),options.intervalMs??INTERVAL_MS);timer.unref?.();void tick()},
  async stop(){stopped=true;abort.abort();if(timer)clearInterval(timer);timer=undefined;await inFlight},
 }
}
