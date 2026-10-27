import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { compareVersions, planRelease, publishRelease, verifyProduction } from '../../scripts/release.mjs'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml') as { load: (source: string) => any }
const root = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '')
const workflow = yaml.load(readFileSync(`${root}/.github/workflows/browser-extension-release.yml`, 'utf8'))
const version = JSON.parse(readFileSync(`${root}/apps/browser-extension/static/manifest.json`, 'utf8')).version
const sha = 'a'.repeat(40), oldSha = 'b'.repeat(40)
const extensionId = 'nnmbbacnkekaoccmkmlfaghjaamgdpjn'
const revision = (state: string, ...versions: string[]) => ({
  state, distributionChannels: versions.map(crxVersion => ({ crxVersion, deployPercentage: 100 })),
})
const store = (overrides: Record<string, unknown> = {}) => ({
  itemId: extensionId, publishedItemRevisionStatus: revision('PUBLISHED', '1.0.0'), ...overrides,
})

function runtime({ main = sha, checkout = sha, runs, status = store(), tokenStatus = 200, storeStatus = 200,
  token = { access_token: 'temporary-access-token' }, envOverrides = {} }: any = {}) {
  const env = {
    CHROME_WEB_STORE_PUBLISHER_ID: 'publisher', CHROME_WEB_STORE_CLIENT_ID: 'client',
    CHROME_WEB_STORE_CLIENT_SECRET: 'secret', CHROME_WEB_STORE_REFRESH_TOKEN: 'refresh',
    ...envOverrides,
  }
  const execute = vi.fn((file: string, args: string[], _options: { env?: Record<string, string>; stdio?: string } = {}) => {
    if (file === 'bash') return ''
    if (file === 'git' && args.join(' ') === 'rev-parse HEAD') return checkout
    if (file === 'gh' && args[1].endsWith('/git/ref/heads/main')) return JSON.stringify({ object: { sha: main } })
    if (file === 'gh' && args[1].includes('/actions/workflows/ci.yml/runs?')) return JSON.stringify({ workflow_runs: runs ?? [{
      head_sha: sha, head_branch: 'main', head_repository: { full_name: 'use-brian/use-brian' },
      event: 'push', status: 'completed', conclusion: 'success', run_number: 1, run_attempt: 1,
    }] })
    throw new Error(`Unexpected command: ${file} ${args.join(' ')}`)
  })
  const request = vi.fn(async (url: string, _options: RequestInit = {}) => {
    if (url === 'https://oauth2.googleapis.com/token') return Response.json(token, { status: tokenStatus })
    if (url === `https://chromewebstore.googleapis.com/v2/publishers/publisher/items/${extensionId}:fetchStatus`) {
      return Response.json(status, { status: storeStatus })
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  return { execute, request, env }
}

describe('[COMP:ext/chrome-release-ci] automated Chrome releases', () => {
  it.each([
    ['1.1', '1.1.0.0', 0], ['1.1.0.1', '1.1', 1], ['1.10', '1.9.9', 1], ['1.1', '2', -1],
  ])('compares Chrome versions %s and %s numerically', (left, right, sign) => {
    expect(Math.sign(compareVersions(left, right))).toBe(sign)
  })

  it.each(['0', '0.0.0.0', '01.2', '1.2.3.4.5', '1.2-beta', '1.65536', '', 'Infinity'])('rejects invalid versions: %s', value => {
    expect(() => planRelease(value, store())).toThrow('Invalid Chrome version')
  })

  it('plans only a version greater than every published rollout channel', () => {
    expect(planRelease('1.1.0', store()).release).toBe(true)
    expect(planRelease('1.1.0', store({ publishedItemRevisionStatus: revision('PUBLISHED', '1.0.0', '1.1') })).release).toBe(false)
    expect(planRelease('1.1.0', store({ publishedItemRevisionStatus: revision('PUBLISHED_TO_TESTERS', '2.0') })).release).toBe(false)
  })

  it.each(['PENDING_REVIEW', 'STAGED'])('preserves an active %s revision, even for a newer candidate', state => {
    const status = store({ submittedItemRevisionStatus: revision(state, '1.1.0') })
    expect(planRelease('1.1.0', status).release).toBe(false)
    expect(planRelease('1.2.0', status).release).toBe(false)
  })

  it('waits for asynchronous validation without starting another upload', () => {
    expect(planRelease('1.1.0', store({ lastAsyncUploadState: 'IN_PROGRESS' })).release).toBe(false)
  })

  it.each(['REJECTED', 'CANCELLED'])('requires a corrected higher version after %s', state => {
    const status = store({ submittedItemRevisionStatus: revision(state, '1.1.0') })
    expect(() => planRelease('1.1.0', status)).toThrow('higher corrected version')
    expect(planRelease('1.2.0', status).release).toBe(true)
  })

  it.each([
    { warned: true }, { takenDown: true }, { itemId: 'another-item' },
    { publishedItemRevisionStatus: undefined },
    { publishedItemRevisionStatus: revision('PUBLISHED', 'not-a-version') },
    { publishedItemRevisionStatus: revision('PUBLISHED') },
    { submittedItemRevisionStatus: revision('UNKNOWN_STATE', '1.1') },
    { submittedItemRevisionStatus: revision('PENDING_REVIEW') },
  ])('fails closed on policy problems or malformed Store status: %j', status => {
    expect(() => planRelease('1.1.0', store(status))).toThrow()
  })

  it('skips obsolete production before accessing any OAuth credentials', async () => {
    const r = runtime({ main: oldSha })
    expect(verifyProduction(sha, r.execute)).toBe(false)
    expect((await publishRelease(sha, r)).release).toBe(false)
    expect(r.request).not.toHaveBeenCalled()
    expect(r.execute.mock.calls.some(([file]) => file === 'bash')).toBe(false)
  })

  it.each([
    { conclusion: 'failure' }, { status: 'in_progress' }, { event: 'pull_request' },
    { head_repository: { full_name: 'someone/fork' } }, { head_branch: 'develop' }, { head_sha: oldSha },
  ])('refuses CI that is unsuccessful or belongs to another source: %j', async override => {
    const r = runtime()
    const base = JSON.parse(r.execute('gh', ['api', 'test/actions/workflows/ci.yml/runs?'])).workflow_runs[0]
    const rejected = runtime({ runs: [{ ...base, ...override }] })
    await expect(publishRelease(sha, rejected)).rejects.toThrow('latest main push CI')
    expect(rejected.request).not.toHaveBeenCalled()
  })

  it('rejects a failed rerun even when an older run succeeded', () => {
    const r = runtime()
    const base = JSON.parse(r.execute('gh', ['api', 'test/actions/workflows/ci.yml/runs?'])).workflow_runs[0]
    const failed = runtime({ runs: [base, { ...base, run_attempt: 2, conclusion: 'failure' }] })
    expect(() => verifyProduction(sha, failed.execute)).toThrow('latest main push CI')
    expect(() => verifyProduction(sha, runtime({ checkout: oldSha }).execute)).toThrow('Checkout')
    expect(() => verifyProduction('main', r.execute)).toThrow('full source commit SHA')
  })

  it('writes verified workflow outputs and rejects production drift through the actual CLI', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'chrome-release-ci-'))
    try {
      const scripts = join(fixture, 'apps/browser-extension/scripts')
      const bin = join(fixture, 'bin')
      mkdirSync(scripts, { recursive: true })
      mkdirSync(bin)
      copyFileSync(`${root}/apps/browser-extension/scripts/release.mjs`, join(scripts, 'release.mjs'))
      writeFileSync(join(bin, 'git'), `#!${process.execPath}\nconsole.log(process.env.TEST_SOURCE_SHA)\n`, { mode: 0o755 })
      writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const path = process.argv[3]
if (path.endsWith('/git/ref/heads/main')) console.log(JSON.stringify({ object: { sha: process.env.TEST_MAIN_SHA } }))
else if (path.includes('/actions/workflows/ci.yml/runs?')) console.log(JSON.stringify({ workflow_runs: [{
  head_sha: process.env.TEST_SOURCE_SHA, head_branch: 'main', event: 'push',
  head_repository: { full_name: 'use-brian/use-brian' }, status: 'completed', conclusion: 'success',
  run_number: 1, run_attempt: 1,
}] }))
else process.exit(2)
`, { mode: 0o755 })
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_SOURCE_SHA: sha,
        TEST_MAIN_SHA: sha, GITHUB_OUTPUT: join(fixture, 'outputs') }
      const verify = spawnSync(process.execPath, [join(scripts, 'release.mjs'), 'verify', sha], { env, encoding: 'utf8' })
      expect(verify.status, verify.stderr).toBe(0)
      expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe(`ready=true\nsha=${sha}\n`)
      const movedEnv = { ...env, TEST_MAIN_SHA: oldSha }
      const skipped = spawnSync(process.execPath, [join(scripts, 'release.mjs'), 'verify', sha], { env: movedEnv, encoding: 'utf8' })
      expect(skipped.status, skipped.stderr).toBe(0)
      expect(JSON.parse(skipped.stdout).ready).toBe(false)
      const blocked = spawnSync(process.execPath, [join(scripts, 'release.mjs'), 'verify-upload', sha], { env: movedEnv, encoding: 'utf8' })
      expect(blocked.status).toBe(1)
      expect(blocked.stderr).toContain('refusing to upload obsolete source')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('refreshes OAuth once and delegates publishing with an exact source binding', async () => {
    const r = runtime()
    expect((await publishRelease(sha, r)).release).toBe(true)
    expect(r.request).toHaveBeenCalledTimes(2)
    const oauth = r.request.mock.calls[0][1] as RequestInit
    expect(oauth.method).toBe('POST')
    expect(Object.fromEntries(oauth.body as URLSearchParams)).toEqual({
      client_id: 'client', client_secret: 'secret', refresh_token: 'refresh', grant_type: 'refresh_token',
    })
    expect(r.request.mock.calls[1][1].headers).toEqual({ Authorization: 'Bearer temporary-access-token' })
    const upload = r.execute.mock.calls.find(([file]) => file === 'bash')
    expect(upload?.[1]).toEqual([`${root}/scripts/publish-browser-extension.sh`, '--publish', '--auto-publish', '--yes'])
    expect(upload?.[2].env).toMatchObject({
      CHROME_WEB_STORE_ACCESS_TOKEN: 'temporary-access-token', CHROME_WEB_STORE_SOURCE_SHA: sha,
    })
  })

  it.each([
    store({ publishedItemRevisionStatus: revision('PUBLISHED', version) }),
    store({ submittedItemRevisionStatus: revision('PENDING_REVIEW', version) }),
    store({ submittedItemRevisionStatus: revision('PUBLISHED', version) }),
    store({ submittedItemRevisionStatus: revision('PUBLISHED_TO_TESTERS', version) }),
  ])('does not invoke packaging or upload on duplicate CI runs', async status => {
    const r = runtime({ status })
    expect((await publishRelease(sha, r)).release).toBe(false)
    expect(r.execute.mock.calls.some(([file]) => file === 'bash')).toBe(false)
  })

  it.each([{ tokenStatus: 400 }, { storeStatus: 403 }, { token: {} },
    { envOverrides: { CHROME_WEB_STORE_REFRESH_TOKEN: '' } }])('fails before publishing on missing credentials/API errors: %j', async options => {
    const r = runtime(options)
    await expect(publishRelease(sha, r)).rejects.toThrow()
    expect(r.execute.mock.calls.some(([file]) => file === 'bash')).toBe(false)
  })

  it('propagates a failed upload or submission so CI cannot report success', async () => {
    const r = runtime()
    const execute = (file: string, args: string[]) => {
      if (file === 'bash') throw new Error('Submission failed')
      return r.execute(file, args)
    }
    await expect(publishRelease(sha, { ...r, execute })).rejects.toThrow('Submission failed')
  })

  it('runs only after trusted main push CI, or manual dispatch on main', () => {
    expect(workflow.on.workflow_run).toEqual({ workflows: ['CI'], branches: ['main'], types: ['completed'] })
    const github = {
      repository: 'use-brian/use-brian', event_name: 'workflow_run', ref: 'refs/heads/main',
      event: { workflow_run: { conclusion: 'success', event: 'push', head_branch: 'main',
        head_repository: { full_name: 'use-brian/use-brian' } } },
    }
    const allows = (context: any) => runInNewContext(workflow.jobs.verify.if, { github: context })
    expect(allows(github)).toBe(true)
    for (const override of [{ conclusion: 'failure' }, { event: 'pull_request' }, { head_branch: 'develop' },
      { head_repository: { full_name: 'someone/fork' } }]) {
      expect(allows({ ...github, event: { workflow_run: { ...github.event.workflow_run, ...override } } })).toBe(false)
    }
    expect(allows({ ...github, repository: 'someone/fork' })).toBe(false)
    expect(allows({ ...github, event_name: 'pull_request' })).toBe(false)
    expect(allows({ ...github, event_name: 'workflow_dispatch' })).toBe(true)
    expect(allows({ ...github, event_name: 'workflow_dispatch', ref: 'refs/heads/develop' })).toBe(false)
  })

  it('isolates environment secrets behind verification and retains only this run’s packages', () => {
    expect(workflow.concurrency['cancel-in-progress']).toBe(false)
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' })
    expect(JSON.stringify(workflow.jobs.verify)).not.toContain('secrets.')
    expect(workflow.jobs.publish.environment).toBe('browser-extension-release')
    expect(workflow.jobs.publish.needs).toBe('verify')
    expect(workflow.jobs.publish.if).toBe("needs.verify.outputs.ready == 'true'")
    const steps = workflow.jobs.publish.steps
    const checkout = steps.find((step: any) => step.uses?.startsWith('actions/checkout'))
    expect(checkout.with).toEqual({ ref: '${{ needs.verify.outputs.sha }}', 'persist-credentials': false })
    const publish = steps.find((step: any) => step.run?.includes('release.mjs publish'))
    expect(Object.keys(publish.env).filter(name => name.startsWith('CHROME_WEB_STORE_'))).toEqual([
      'CHROME_WEB_STORE_PUBLISHER_ID', 'CHROME_WEB_STORE_CLIENT_ID', 'CHROME_WEB_STORE_CLIENT_SECRET', 'CHROME_WEB_STORE_REFRESH_TOKEN',
    ])
    expect(steps.indexOf(publish)).toBeGreaterThan(steps.findIndex((step: any) => step.run === 'pnpm install --frozen-lockfile'))
    const artifact = steps.find((step: any) => step.uses?.startsWith('actions/upload-artifact'))
    expect(artifact.if).toContain('always()')
    expect(artifact.with.path).toBe('apps/browser-extension/release/*.zip')
    expect(JSON.stringify(workflow)).not.toContain('actions/download-artifact')
    expect(JSON.stringify(workflow)).not.toContain('pull_request_target')
  })

  it('rechecks production after building and before the first Store write', () => {
    const script = readFileSync(`${root}/scripts/publish-browser-extension.sh`, 'utf8')
    const guard = script.indexOf('verify-upload "$CHROME_WEB_STORE_SOURCE_SHA"')
    expect(guard).toBeGreaterThan(script.indexOf('==> Building browser extension'))
    expect(guard).toBeLessThan(script.indexOf('UPLOAD_RESPONSE="$(api_call POST'))
  })
})
