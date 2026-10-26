// [COMP:platform/local-rig] Administrative fixtures never inherit a real provider profile.
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

export const ADMIN_DATABASE_URL = 'postgres://brian:brian@127.0.0.1:5443/usebrian_admin_test'
export const ADMIN_APP_DATABASE_URL = 'postgres://app_user:fixture-only@127.0.0.1:5443/usebrian_admin_test'
export function adminDatabaseUrls(env={}) {
  const port=String(env.BRIAN_ADMIN_PG_PORT || '5443')
  if(!/^\d+$/.test(port)||Number(port)<1024||Number(port)>64535)throw new Error('Invalid administrative fixture database port')
  return {port,databaseUrl:ADMIN_DATABASE_URL.replace(':5443/',`:${port}/`),appDatabaseUrl:ADMIN_APP_DATABASE_URL.replace(':5443/',`:${port}/`)}
}
export function adminStateDirectory(root,env={}) {
 const {port}=adminDatabaseUrls(env)
 return join(root,'.rig',port==='5443'?'admin':'admin-'+port)
}
export function adminDeadline(original={},now=Date.now()) {
 const raw=original.BRIAN_ADMIN_DEADLINE_UTC
 if(raw!==undefined&&(typeof raw!=='string'||!/(?:Z|\+00:00)$/.test(raw)))throw new Error('Administrative deadline must be UTC')
 const end=raw===undefined?now+600000:Date.parse(raw)
 if(!Number.isFinite(end)||end<=now||end>now+1500000)throw new Error('Administrative deadline must be within25minutes')
 return new Date(end).toISOString()
}
const osKeys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'SystemRoot', 'ComSpec', 'PATHEXT']

export function adminRigEnvironment(root, original = {}, readText = path => existsSync(path) ? readFileSync(path, 'utf8') : '') {
  const database=adminDatabaseUrls(original),state=adminStateDirectory(root,original)
  const env = Object.fromEntries(osKeys.filter(key => original[key] !== undefined).map(key => [key, original[key]]))
  // Prevent dotenv/Next children from refilling omitted secrets. Only key names
  // are copied, always with empty values; the real provider profile is never read.
  for (const directory of ['', 'apps/api', 'apps/app-web', 'apps/doc-sync', 'apps/auth-web']) {
    for (const filename of ['.env', '.env.local', '.env.development', '.env.development.local']) {
      for (const line of readText(join(root, directory, filename)).split(/\r?\n/)) {
        const key = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=/)?.[1]
        if (key && !osKeys.includes(key)) env[key] = ''
      }
    }
  }
  return {
    ...env,
    DATABASE_URL: database.databaseUrl,
    DATABASE_URL_APP: database.appDatabaseUrl,
    BRIAN_ADMIN_PG_PORT: database.port,
    BRIAN_ADMIN_DEADLINE_UTC:adminDeadline(original),
    MIGRATION_DIRS: '',
    AUTH_PORTAL_URL:'http://localhost:3005',AUTHED_APP_URL:'http://localhost:3003',PUBLIC_PRIMARY_AUTH_URL:'http://localhost:3005',
    INTERNAL_API_URL:'http://127.0.0.1:'+String(original.USEBRIAN_API_PORT||'4100'),
    SMTP_HOST:'127.0.0.1',SMTP_PORT:String(Number(database.port)+1000),SMTP_SECURE:'false',
    SMTP_USER:'capture@fixture.example',SMTP_PASSWORD:'fixture-only',EMAIL_FROM_ADDRESS:'auth@fixture.example',
    USEBRIAN_ADMIN_ONLY: '1',
    USEBRIAN_API_PORT: original.USEBRIAN_API_PORT || '4100',
    USEBRIAN_CORE_ONLY: '1',
    USEBRIAN_NO_BROWSER: '1',
    USEBRIAN_OWNER_NAME: 'Fixture Administrator',
    USEBRIAN_CONFIG_DIR: join(state, 'config'),
    LOCAL_FILES_DIR: join(state, 'files'),
    BRIAN_MESSAGE_STORE_ENABLED: '0',
    NEXT_TELEMETRY_DISABLED: '1',
    DO_NOT_TRACK: '1',
    BRIAN_SUPPORT_DIAGNOSTICS_ENABLED: 'false',
  }
}

export function adminRuntimeNodeOptions(root) {
  return `--import=${pathToFileURL(join(root, 'scripts', 'rig-loopback-only.mjs')).href}`
}


/** Persist ownership independently of the launcher, which may itself be killed. */
export function recordAdminGroups(root, runId, groups, composition='normal') {
  if(!['normal','reference'].includes(composition))throw new Error('Invalid administrative application composition')
  const directory=adminStateDirectory(root,process.env)
  mkdirSync(directory,{recursive:true})
  writeFileSync(join(directory,'process-groups.json'),JSON.stringify({root,runId,groups,runtimeRole:'app_user',composition,launcherPid:process.pid,deadlineUtc:process.env.BRIAN_ADMIN_DEADLINE_UTC??null}),{mode:0o600})
}

/** Refuse running old composition before any database changes. */
export function assertAdminRuntimeComposition(root, composition='normal', launcherPid=process.pid, execute=execFileSync) {
  const path=join(adminStateDirectory(root,process.env),'process-groups.json')
  const record=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null
  const refuse=()=>{throw new Error('Administrative runtime composition changed; run scripts/rig-down.sh --admin-only --keep-db, then repeat rig-up with the same port')}
  if(!['normal','reference'].includes(composition)||record?.root!==root||record.runtimeRole!=='app_user'||record.composition!==composition||!/^[a-f0-9]{32}$/.test(record.runId)||!Array.isArray(record.groups)||record.groups.some(pid=>!Number.isInteger(pid)||pid<2)||!Number.isInteger(launcherPid)||launcherPid<2)refuse()
  // The launcher sets its own marker after exec; macOS ps need not expose it.
  // Child groups inherit the startup marker and must still belong to that launcher.
  const processes=execute('ps',['-axo','pid=,ppid=,pgid='],{encoding:'utf8'}).trim().split(/\n/).map(line=>line.trim().split(/\s+/).map(Number))
  let live=0
  for(const group of new Set(record.groups)){
    const members=processes.filter(([,,pgid])=>pgid===group)
    if(!members.length)continue
    live++
    if(!members.some(([pid,parent])=>pid===group&&parent===launcherPid))refuse()
    let bound=false
    for(const [pid] of members){
      const detail=execute('ps',['eww','-p',String(pid),'-o','command='],{encoding:'utf8'})
      if(detail.match(/(?:^|\s)USEBRIAN_ADMIN_RUN_ID=([^\s]+)/)?.[1]!==record.runId)continue
      let current=pid;const seen=new Set()
      while(current!==group&&!seen.has(current)){seen.add(current);current=members.find(([id])=>id===current)?.[1]}
      if(current===group)bound=true
    }
    if(!bound)refuse()
  }
  if(!live)refuse()
}

export function stopOwnedAdminGroups(root, execute=execFileSync, signal=process.kill.bind(process)) {
  const path=join(adminStateDirectory(root,process.env),'process-groups.json')
  if(!existsSync(path))return 0
  const record=JSON.parse(readFileSync(path,'utf8'))
  if(record.root!==root||!/^[a-f0-9]{32}$/.test(record.runId)||!Array.isArray(record.groups)||record.groups.some(pid=>!Number.isInteger(pid)||pid<2))throw new Error('Invalid administrative process ownership record')
  const processes=execute('ps',['-axo','pid=,ppid=,pgid='],{encoding:'utf8'}).trim().split(/\n/).map(line=>line.trim().split(/\s+/).map(Number))
  const groups=[...new Set(record.groups)].filter(group=>processes.some(([,,pgid])=>pgid===group))
  for(const group of groups){
    const members=processes.filter(([,,pgid])=>pgid===group),verified=new Set(),remaining=[]
    for(const [pid] of members){
      let detail
      try{detail=execute('ps',['eww','-p',String(pid),'-o','command='],{encoding:'utf8'})}
      catch(error){try{signal(pid,0)}catch(gone){if(gone.code==='ESRCH')continue;throw gone}throw error}
      const marker=detail.match(/(?:^|\s)USEBRIAN_ADMIN_RUN_ID=([^\s]+)/)?.[1]
      if(marker===record.runId)verified.add(pid)
      else if(marker)throw new Error('Recorded administrative process group has an unverified member; no groups were signaled')
      else remaining.push(pid)
    }
    // Setting process.title can hide the original environment from macOS ps.
    // A live parent chain within the same verified group is independent proof.
    for(const pid of remaining){
      let current=pid;const seen=new Set()
      while(!verified.has(current)&&!seen.has(current)){
        seen.add(current)
        const parent=members.find(([candidate])=>candidate===current)?.[1]
        if(!parent)break
        current=parent
      }
      if(!verified.has(current))throw new Error('Recorded administrative process group has an unverified member; no groups were signaled')
    }
  }
  for(const group of groups){try{signal(-group,'SIGTERM')}catch(error){if(error.code!=='ESRCH')throw error}}
  // Retain the receipt until a later call confirms that all groups have exited.
  if(!groups.length)unlinkSync(path)
  return groups.length
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv[2]==='--verify-composition'&&process.argv[3]){assertAdminRuntimeComposition(process.argv[3],process.argv[4],Number(process.argv[5]))}
  else {
  if(process.argv[2]!=='--stop-owned'||!process.argv[3])throw new Error('Expected --stop-owned <checkout-root>')
  console.log(`[rig] signaled ${stopOwnedAdminGroups(process.argv[3])} verified administrative runtime groups`)
  }
}
