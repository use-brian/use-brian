// [COMP:platform/local-rig] Administrative fixtures never inherit a real provider profile.
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

export const ADMIN_DATABASE_URL = 'postgres://brian:brian@127.0.0.1:5443/usebrian_admin_test'
export const ADMIN_APP_DATABASE_URL = 'postgres://admin_fixture_app:fixture-only@127.0.0.1:5443/usebrian_admin_test'
const osKeys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'SystemRoot', 'ComSpec', 'PATHEXT']

export function adminRigEnvironment(root, original = {}, readText = path => existsSync(path) ? readFileSync(path, 'utf8') : '') {
  const env = Object.fromEntries(osKeys.filter(key => original[key] !== undefined).map(key => [key, original[key]]))
  // Prevent dotenv/Next children from refilling omitted secrets. Only key names
  // are copied, always with empty values; the real provider profile is never read.
  for (const directory of ['', 'apps/api', 'apps/app-web', 'apps/doc-sync']) {
    for (const filename of ['.env', '.env.local', '.env.development', '.env.development.local']) {
      for (const line of readText(join(root, directory, filename)).split(/\r?\n/)) {
        const key = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=/)?.[1]
        if (key && !osKeys.includes(key)) env[key] = ''
      }
    }
  }
  return {
    ...env,
    DATABASE_URL: ADMIN_DATABASE_URL,
    DATABASE_URL_APP: ADMIN_APP_DATABASE_URL,
    MIGRATION_DIRS: '',
    USEBRIAN_ADMIN_ONLY: '1',
    USEBRIAN_API_PORT: original.USEBRIAN_API_PORT || '4100',
    USEBRIAN_CORE_ONLY: '1',
    USEBRIAN_NO_BROWSER: '1',
    USEBRIAN_OWNER_NAME: 'Fixture Administrator',
    USEBRIAN_CONFIG_DIR: join(root, '.rig', 'admin', 'config'),
    LOCAL_FILES_DIR: join(root, '.rig', 'admin', 'files'),
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
export function recordAdminGroups(root, runId, groups) {
  const directory=join(root,'.rig','admin')
  mkdirSync(directory,{recursive:true})
  writeFileSync(join(directory,'process-groups.json'),JSON.stringify({root,runId,groups}),{mode:0o600})
}

export function stopOwnedAdminGroups(root, execute=execFileSync, signal=process.kill.bind(process)) {
  const path=join(root,'.rig','admin','process-groups.json')
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
  if(process.argv[2]!=='--stop-owned'||!process.argv[3])throw new Error('Expected --stop-owned <checkout-root>')
  console.log(`[rig] signaled ${stopOwnedAdminGroups(process.argv[3])} verified administrative runtime groups`)
}
