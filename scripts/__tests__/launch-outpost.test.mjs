import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveDocSyncLaunch, resolveOutpostMailbox } from '../launch-outpost.mjs'

for (const [label, outpost, override, expected] of [
  ['OSS default', false, undefined, 8080],
  ['Outpost default', true, undefined, 8180],
  ['OSS custom', false, '9200', 9200],
  ['Outpost custom', true, '9201', 9201],
]) {
  test(`${label}: sidecar and browser share the selected port`, () => {
    const result = resolveDocSyncLaunch({ USEBRIAN_DOC_SYNC_PORT: override }, outpost)
    assert.equal(result.port, expected)
    assert.deepEqual(result.env, {
      DOC_SYNC_URL: `ws://127.0.0.1:${expected}`,
      PUBLIC_DOC_SYNC_URL: `ws://localhost:${expected}`,
      NEXT_PUBLIC_DOC_SYNC_URL: `ws://localhost:${expected}`,
    })
  })
}

test('explicit public deployment URL wins without changing the local sidecar', () => {
  const result = resolveDocSyncLaunch({
    USEBRIAN_DOC_SYNC_PORT: '9191',
    PUBLIC_DOC_SYNC_URL: 'wss://sync.deployment.example/path',
    NEXT_PUBLIC_DOC_SYNC_URL: 'wss://old.example',
    DOC_SYNC_DOMAIN: 'domain.example',
  }, true)
  assert.equal(result.env.PUBLIC_DOC_SYNC_URL, 'wss://sync.deployment.example/path')
  assert.equal(result.env.NEXT_PUBLIC_DOC_SYNC_URL, result.env.PUBLIC_DOC_SYNC_URL)
  assert.equal(result.env.DOC_SYNC_URL, 'ws://127.0.0.1:9191')
})

test('legacy browser URL and domain deployment configuration remain supported', () => {
  assert.equal(resolveDocSyncLaunch({ NEXT_PUBLIC_DOC_SYNC_URL: 'wss://legacy.example' }).env.PUBLIC_DOC_SYNC_URL, 'wss://legacy.example')
  assert.equal(resolveDocSyncLaunch({ DOC_SYNC_DOMAIN: 'sync.example' }).env.PUBLIC_DOC_SYNC_URL, 'wss://sync.example')
})

test('ports reject malformed, fractional and out-of-range values without echoing input', () => {
  for (const value of ['0', '-1', '65536', '1.5', 'abc', ' ', '2525secret']) {
    assert.throws(() => resolveDocSyncLaunch({ USEBRIAN_DOC_SYNC_PORT: value }), /^Error: USEBRIAN_DOC_SYNC_PORT must be an integer from 1 to 65535$/)
    assert.throws(() => resolveOutpostMailbox({ SMTP_PORT: value }, true), /^Error: SMTP_PORT must be an integer from 1 to 65535$/)
  }
  for (const value of ['1', '65535']) assert.equal(resolveDocSyncLaunch({ USEBRIAN_DOC_SYNC_PORT: value }).port, Number(value))
})

test('default Outpost synthetic login uses fixed mailbox credentials and .example identities', () => {
  const result = resolveOutpostMailbox({}, true)
  assert.equal(result.enabled, true)
  assert.equal(result.port, 2525)
  assert.deepEqual(result.env, {
    SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_SECURE: 'false',
    SMTP_USER: 'capture@fixture.example', SMTP_PASSWORD: 'fixture-only',
    EMAIL_FROM_ADDRESS: 'auth@fixture.example', OUTPOST_AUTH_BOOTSTRAP_EMAILS: 'admin@fixture.example',
  })
  const mailbox = readFileSync(new URL('../rig-mailbox.mjs', import.meta.url), 'utf8')
  assert.ok(mailbox.includes(`user='${result.env.SMTP_USER}'`))
  assert.ok(mailbox.includes(`password='${result.env.SMTP_PASSWORD}'`))
  assert.deepEqual(resolveOutpostMailbox({}, false), { enabled: false, env: {} })
})

for (const custom of [
  { SMTP_HOST: 'mail.deployment.example', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: 'private-user', SMTP_PASSWORD: 'private-password' },
  { SMTP_HOST: 'localhost' }, { SMTP_PORT: '2526' },
  { SMTP_USER: 'custom-user' }, { SMTP_PASSWORD: 'custom-password' },
  { SMTP_SECURE: 'false' }, { SMTP_SERVICE: 'custom-provider' },
]) {
  test(`custom SMTP (${Object.keys(custom).join(',')}) disables fixture without replacing settings`, () => {
    const input = Object.freeze({ ...custom })
    const result = resolveOutpostMailbox(input, true)
    assert.deepEqual(result, { enabled: false, env: {} })
    assert.deepEqual({ ...input, ...result.env }, custom)
    assert.equal(result.port, undefined)
  })
}

test('fixture identities can be customized independently of SMTP', () => {
  const result = resolveOutpostMailbox({ EMAIL_FROM_ADDRESS: 'auth@local.example', OUTPOST_AUTH_BOOTSTRAP_EMAILS: 'owner@local.example' }, true)
  assert.equal(result.enabled, true)
  assert.equal(result.env.EMAIL_FROM_ADDRESS, 'auth@local.example')
  assert.equal(result.env.OUTPOST_AUTH_BOOTSTRAP_EMAILS, 'owner@local.example')
})

test('launcher wires helper policy to child env, sidecar port and conditional mailbox spawn', () => {
  const source = readFileSync(new URL('../launch.mjs', import.meta.url), 'utf8')
  assert.match(source, /import \{ resolveDocSyncLaunch, resolveOutpostMailbox \} from '\.\/launch-outpost\.mjs'/)
  assert.match(source, /const docSyncLaunch = resolveDocSyncLaunch\(process\.env, outpostLocal\)/)
  assert.match(source, /const mailboxLaunch = resolveOutpostMailbox\(process\.env, outpostLocal\)/)
  assert.match(source, /docSync: docSyncLaunch\.port/)
  assert.match(source, /const env = \{\s*\.\.\.process\.env,/)
  assert.match(source, /\.\.\.docSyncLaunch\.env,/)
  assert.match(source, /\.\.\.mailboxLaunch\.env,/)
  assert.match(source, /run\('doc-sync',[\s\S]*?\{ PORT: String\(PORTS\.docSync\) \}/)
  const outpostBranch = source.slice(source.indexOf('} else if (outpostLocal) {'), source.indexOf('console.log(`[launch] starting api'))
  assert.match(outpostBranch, /if \(mailboxLaunch\.enabled\) \{[\s\S]*?run\('mailbox',[\s\S]*?String\(mailboxLaunch\.port\)\]\)[\s\S]*?await waitForPort\(mailboxLaunch\.port,[\s\S]*?\n  \}/)
  assert.match(outpostBranch, /run\('auth-web'/)
  assert.doesNotMatch(outpostBranch, /env\.SMTP_PORT|smtpPort/)
  assert.doesNotMatch(source, /SMTP_(?:HOST|PORT|SECURE|USER|PASSWORD):/)
  assert.doesNotMatch(source, /console\.(?:log|warn|error)\([^\n]*(?:SMTP_|mailboxLaunch\.env)/)
})
