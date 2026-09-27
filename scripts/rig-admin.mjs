// [COMP:platform/local-rig] Administrative fixtures never inherit a real provider profile.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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
