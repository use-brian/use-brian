import dotenv from 'dotenv'
import { bootOpenApi, type OpenApiEnv } from '@use-brian/api/boot.js'
import { buildEpisodeIngestors } from '@use-brian/api/build-episode-ingestors.js'
import { buildOpenChannelHosts } from '@use-brian/api/channel-hosts.js'
import { createBrowserCredentialStore } from '@use-brian/api/db/browser-credential-store.js'
import { createBrowserProfileStore } from '@use-brian/api/db/browser-profile-store.js'
import { createBrowserSessionVault } from '@use-brian/api/db/browser-session-vault.js'
import { createBrowserSkillGrantStore } from '@use-brian/api/db/browser-skill-grant-store.js'
import { createSandboxTaskStore } from '@use-brian/api/db/sandbox-task-store.js'
import { parseStrictBoolean } from '@use-brian/api/auth/outpost-auth-config.js'
import { assertOutpostRuntime } from './runtime.js'

dotenv.config()

const JWT_SECRET = assertOutpostRuntime(process.env)

parseStrictBoolean(process.env.OUTPOST_AUTH_EMAIL_ENABLED, 'OUTPOST_AUTH_EMAIL_ENABLED', true)
parseStrictBoolean(process.env.OUTPOST_AUTH_OIDC_ENABLED, 'OUTPOST_AUTH_OIDC_ENABLED', false)
parseStrictBoolean(process.env.OUTPOST_OIDC_SUBJECT_IDENTITY_ENABLED, 'OUTPOST_OIDC_SUBJECT_IDENTITY_ENABLED', false)

const env: OpenApiEnv = {
  ...process.env,
  JWT_SECRET,
  NODE_ENV: process.env.NODE_ENV ?? 'production',
  API_URL: process.env.API_URL ?? 'http://localhost:4000',
  APP_URL: process.env.APP_URL ?? 'http://localhost:3003',
  OUTPOST_AUTH_EMAIL_ENABLED: !['false', '0'].includes(
    (process.env.OUTPOST_AUTH_EMAIL_ENABLED ?? '').trim().toLowerCase(),
  ),
  OUTPOST_AUTH_OIDC_ENABLED: ['true', '1'].includes(
    (process.env.OUTPOST_AUTH_OIDC_ENABLED ?? '').trim().toLowerCase(),
  ),
  OUTPOST_OIDC_SUBJECT_IDENTITY_ENABLED: ['true', '1'].includes(
    (process.env.OUTPOST_OIDC_SUBJECT_IDENTITY_ENABLED ?? '').trim().toLowerCase(),
  ),
  VOICE_TRANSCRIPTION_ENABLED: !['false', '0'].includes(
    (process.env.VOICE_TRANSCRIPTION_ENABLED ?? '').trim().toLowerCase(),
  ),
  SUPPORT_DIAGNOSTICS_ENABLED: !['false', '0'].includes(
    (process.env.BRIAN_SUPPORT_DIAGNOSTICS_ENABLED ?? '').trim().toLowerCase(),
  ),
  LOCAL_FILESYSTEM_SOURCES_ENABLED: process.env.LOCAL_FILESYSTEM_SOURCES_ENABLED === 'true',
  FALLBACK_PROVIDER_ENABLED: process.env.FALLBACK_PROVIDER_ENABLED === 'true',
  COMPUTER_USE_UNATTENDED_ENABLED: process.env.COMPUTER_USE_UNATTENDED_ENABLED === 'true',
  SKILLS_AUTO_GEN_ENABLED: !['false', '0'].includes(
    (process.env.SKILLS_AUTO_GEN_ENABLED ?? '').trim().toLowerCase(),
  ),
}

const browserEncryptionKey = process.env.BROWSER_VAULT_ENCRYPTION_KEY
  ? Buffer.from(process.env.BROWSER_VAULT_ENCRYPTION_KEY, 'base64')
  : null
const browserCredentialEncryptionKey = process.env.BROWSER_CREDENTIAL_ENCRYPTION_KEY
  ? Buffer.from(process.env.BROWSER_CREDENTIAL_ENCRYPTION_KEY, 'base64')
  : null

const { start } = await bootOpenApi({
  env,
  runWorkers: !process.argv.includes('--no-workers'),
  ports: {
    buildEpisodeIngestors,
    buildChannelHosts: buildOpenChannelHosts,
    browserProfileStore: createBrowserProfileStore(),
    browserSkillGrantStore: createBrowserSkillGrantStore(),
    sandboxTaskStore: createSandboxTaskStore(),
    browserSessionVault: browserEncryptionKey
      ? createBrowserSessionVault({ encryptionKey: browserEncryptionKey })
      : undefined,
    browserCredentialStore: browserCredentialEncryptionKey
      ? createBrowserCredentialStore({ encryptionKey: browserCredentialEncryptionKey })
      : undefined,
  },
})

await start()
