import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../../..')

describe('[COMP:sandbox/profiles] OSS browser composition', () => {
  it('creates the complete open persistence schema behind an OSS edition guard', async () => {
    const sql = await readFile(resolve(root, 'packages/api/migrations/438_oss_computer_use.sql'), 'utf8')

    expect(sql).toContain("current_setting('app.migration_edition', true) = 'oss'")
    for (const table of [
      'browser_profiles',
      'browser_sessions',
      'sandbox_tasks',
      'browser_skill_grants',
      'browser_credentials',
    ]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? public\\.${table}`))
    }
    expect(sql).toContain('assistant_routing_notes jsonb')
    expect(sql).toContain('local_control_mode text')
    expect(sql).toContain('browser_started_at timestamptz')
  })

  it('wires every browser persistence port in the standalone OSS entry', async () => {
    const source = await readFile(resolve(root, 'apps/api/src/index.ts'), 'utf8')

    for (const port of [
      'browserProfileStore',
      'browserSkillGrantStore',
      'sandboxTaskStore',
      'browserSessionVault',
      'browserCredentialStore',
    ]) {
      expect(source).toMatch(new RegExp(`${port}:`))
    }
    expect(source).toContain('BROWSER_VAULT_ENCRYPTION_KEY')
    expect(source).toContain('BROWSER_CREDENTIAL_ENCRYPTION_KEY')
  })

  it('starts the local relay and ships the optional cloud template from OSS', async () => {
    const launcher = await readFile(resolve(root, 'scripts/launch.mjs'), 'utf8')
    const template = await readFile(resolve(root, 'scripts/e2b-template/e2b.Dockerfile'), 'utf8')

    expect(launcher).toContain("config.browserRelaySecret")
    expect(launcher).toContain("config.browserVaultEncryptionKey")
    expect(launcher).toContain("config.browserCredentialEncryptionKey")
    expect(launcher).toContain("'@use-brian/browser-relay'")
    expect(launcher).toContain('BROWSER_RELAY_URL:')
    expect(launcher).toContain('BROWSER_VAULT_ENCRYPTION_KEY:')
    expect(launcher).toContain('BROWSER_CREDENTIAL_ENCRYPTION_KEY:')
    expect(template).toContain('FROM e2bdev/code-interpreter:latest')
    expect(template).toContain('browser-use==0.13.4')
    expect(template).toContain('agent-browser@0.31.1')
  })
})
