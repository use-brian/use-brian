import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, identity, command, environment, snapshot, resetSnapshot } from '../testing/preflight-source.mjs'
import { compileWorkflow, executeWorkflow, expression, workflowContext } from '../testing/preflight-workflow.mjs'
import { publicationPlan, runPreflight, verifyReceipt } from '../testing/preflight-push.mjs'

const owned = []
afterEach(async () => { for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true }) })
async function directory() { const path = await mkdtemp(join(tmpdir(), 'preflight-regression-')); owned.push(path); return path }
async function put(root, path, value) { const target = join(root, path); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, value) }
function commit(root) { git(root, ['add', '-A']); git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'test: source fixture']) }
async function repository(workflow, manifest = { name: 'preflight-fixture', private: true }, location) {
  const root = location ?? await directory()
  await mkdir(root, { recursive: true })
  git(root, ['init', '--quiet', '-b', 'develop']); git(root, ['remote', 'add', 'origin', 'https://example.invalid/source.git'])
  await put(root, '.gitignore', 'node_modules/\ndist/\n.turbo/\n.env.local\n')
  await put(root, 'package.json', JSON.stringify(manifest))
  await put(root, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n")
  if (workflow) await put(root, '.github/workflows/ci.yml', JSON.stringify(workflow))
  commit(root); git(root, ['update-ref', 'refs/remotes/origin/develop', git(root, ['rev-parse', 'HEAD']).toString().trim()])
  return root
}
const simple = run => ({ jobs: { 'build-test': { steps: [{ run }] } } })
async function preflight(root, kind = 'oss') {
  const reports = await directory(), reportPath = join(reports, 'receipt.json')
  const report = await runPreflight({ repositories: [{ root, kind }], reportPath })
  return { report, reportPath }
}

describe('[COMP:tooling/push-preflight] actual local publication boundary', () => {
  test('refuses to reset a source checkout without a disposable ownership marker', async () => {
    const root = await repository(simple('true'))
    await put(root, 'unsent.md', 'preserve this work')
    await assert.rejects(resetSnapshot(root), { code: 'ENOENT' })
    assert.equal(await readFile(join(root, 'unsent.md'), 'utf8'), 'preserve this work')
  })
  test('takes current source, deletions and untracked files while excluding stale outputs and ignored credentials', async () => {
    const root = await repository(simple('true'))
    await put(root, 'old.txt', 'old'); commit(root)
    await rm(join(root, 'old.txt')); await put(root, 'current.txt', 'current')
    await put(root, 'packages/example/dist/stale.js', 'stale'); await put(root, '.env.local', 'ignored-canary')
    const target = await directory(), env = environment(target, '/tmp/preflight-store')
    await mkdir(env.HOME); await mkdir(env.TMPDIR)
    const before = await identity(root), clone = join(target, 'source')
    await snapshot(root, clone, env)
    assert.equal(await readFile(join(clone, 'current.txt'), 'utf8'), 'current')
    for (const path of ['old.txt', 'packages/example/dist/stale.js', '.env.local']) await assert.rejects(readFile(join(clone, path)), { code: 'ENOENT' })
    assert.deepEqual(await identity(root), before)
  })

  test('executes build, clean matrix consumers, artifact receipts and the real aggregate gate', async () => {
    const root = await repository({ jobs: {
      build: { steps: [
        { run: 'test ! -e .env.local; echo leaked > tracked.txt; echo leaked > leaked.txt; mkdir -p node_modules packages/example/dist; echo leaked > node_modules/leaked.txt; echo leaked > "$HOME/leaked.txt"; echo compiled > packages/example/dist/index.js; tar -czf "$RUNNER_TEMP/deps.tgz" packages/example/dist' },
        { uses: 'actions/upload-artifact@v4', with: { name: 'deps-${{ github.sha }}', path: '${{ runner.temp }}/deps.tgz', 'if-no-files-found': 'error' } },
      ] },
      tests: { needs: 'build', strategy: { matrix: { part: [1, 2] } }, steps: [
        { run: 'test ! -e packages/example/dist/index.js; test ! -e node_modules/leaked.txt; test ! -e "$HOME/leaked.txt"; test ! -e leaked.txt; test "$(cat tracked.txt)" = original' },
        { uses: 'actions/download-artifact@v4', with: { name: 'deps-${{ github.sha }}', path: '${{ runner.temp }}' } },
        { run: 'tar -xzf "$RUNNER_TEMP/deps.tgz"; test "$(cat packages/example/dist/index.js)" = compiled; echo passed > "$RUNNER_TEMP/part-${{ matrix.part }}.json"' },
        { uses: 'actions/upload-artifact@v4', with: { name: 'receipt-${{ matrix.part }}', path: '${{ runner.temp }}/part-${{ matrix.part }}.json' } },
      ] },
      'build-test': { needs: ['build', 'tests'], steps: [
        { uses: 'actions/download-artifact@v4', with: { pattern: 'receipt-*', path: '${{ runner.temp }}/reports', 'merge-multiple': true } },
        { env: { BUILD: '${{ needs.build.result }}', TESTS: '${{ needs.tests.result }}' },
          run: 'test "$BUILD" = success; test "$TESTS" = success; test "$(cat "$RUNNER_TEMP/reports/part-1.json")" = passed; test "$(cat "$RUNNER_TEMP/reports/part-2.json")" = passed' },
      ] },
    } })
    await put(root, 'tracked.txt', 'original\n'); commit(root)
    await put(root, '.env.local', 'ignored-canary')
    const { report, reportPath } = await preflight(root)
    assert.equal(report.status, 'passed', JSON.stringify(report))
    const verification = report.repositories[0].verification
    assert.equal(verification.jobs.length, 4)
    assert.ok(verification.jobs.every(job => job.status === 'passed' && job.durationMs >= 0))
    assert.ok(verification.criticalPathMs > 0)
    await verifyReceipt(reportPath, [{ root, kind: 'oss' }])
    assert.equal(git(root, ['status', '--porcelain']).toString(), '')
  })

  for (const [name, workflow, message] of [
    ['failed command', simple('exit 7'), /Command failed/],
    ['missing artifact', { jobs: { 'build-test': { steps: [{ uses: 'actions/download-artifact@v4', with: { name: 'absent' } }] } } }, /artifact unavailable/],
    ['unknown required action', { jobs: { 'build-test': { steps: [{ uses: 'example/unsupported@v1' }] } } }, /Unsupported required action/],
    ['unknown failure policy', { jobs: { 'build-test': { steps: [{ run: 'false', 'continue-on-error': '${{ false }}' }] } } }, /conditional continue-on-error/],
    ['job budget', { jobs: { 'build-test': { 'timeout-minutes': 0.002, steps: [{ run: 'node -e "setTimeout(()=>{},5000)"' }] } } }, /budget/],
  ]) test(`blocks publication after ${name} and retains the failed receipt`, async () => {
    const root = await repository(workflow)
    const { report, reportPath } = await preflight(root)
    assert.equal(report.status, 'failed'); assert.match(report.error, message)
    assert.equal(JSON.parse(await readFile(reportPath, 'utf8')).status, 'failed')
    await assert.rejects(verifyReceipt(reportPath), /successful push preflight/)
  })

  test('binds HEAD, staged/working/untracked files, participant kinds and receipt completeness', async () => {
    const root = await repository(simple('true'))
    const { report, reportPath } = await preflight(root)
    assert.equal(report.status, 'passed')
    await assert.rejects(verifyReceipt(reportPath, [{ root, kind: 'companion' }]), /publication repositories/)
    const original = await readFile(join(root, 'package.json'), 'utf8')
    await put(root, 'package.json', original + '\n')
    await assert.rejects(verifyReceipt(reportPath), /Stale/)
    await put(root, 'package.json', original)
    await put(root, 'new.txt', 'new')
    await assert.rejects(verifyReceipt(reportPath), /Stale/)
    git(root, ['add', 'new.txt']); await assert.rejects(verifyReceipt(reportPath), /Stale/)
    commit(root); await assert.rejects(verifyReceipt(reportPath), /Stale/)
    const next = await preflight(root)
    next.report.repositories[0].verification.jobs = []
    await writeFile(next.reportPath, JSON.stringify(next.report))
    await assert.rejects(verifyReceipt(next.reportPath), /Incomplete/)
  })

  test('permits the just-published verified tip but refuses a remote ref beyond it', async () => {
    const root = await repository(simple('true'))
    await put(root, 'new.txt', 'new'); commit(root)
    const { report, reportPath } = await preflight(root)
    assert.equal(report.status, 'passed')
    const head = git(root, ['rev-parse', 'HEAD']).toString().trim()
    git(root, ['update-ref', 'refs/remotes/origin/develop', head])
    await verifyReceipt(reportPath)
    const future = git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree',
      git(root, ['rev-parse', 'HEAD^{tree}']).toString().trim(), '-p', head, '-m', 'test: remote advance']).toString().trim()
    git(root, ['update-ref', 'refs/remotes/origin/develop', future])
    await assert.rejects(verifyReceipt(reportPath), /Stale/)
    git(root, ['update-ref', 'refs/remotes/origin/develop', git(root, ['rev-parse', 'HEAD^']).toString().trim()])
    // A different remote change also invalidates evidence, even if HEAD is stable.
    git(root, ['remote', 'set-url', 'origin', 'https://example.invalid/other.git'])
    await assert.rejects(verifyReceipt(reportPath), /Stale/)
  })

  test('interrupts a subprocess and rejects malformed/disconnected workflow gates', async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 80)
    await assert.rejects(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal }), /interrupted/)
    clearTimeout(timer)
    assert.throws(() => compileWorkflow(JSON.stringify({ jobs: { unused: { steps: [] }, 'build-test': { steps: [] } } }), workflowContext()), /disconnected/)
    assert.throws(() => expression('unknown.value == true', {}), /Unknown CI value/)
  })

  test('detects an actually stale frozen lockfile before executing companion tests', async () => {
    const root = await repository(null, { name: 'preflight-fixture', private: true, dependencies: { 'fictional-dependency': '1.0.0' }, scripts: { test: 'echo must-not-run' } })
    const { report } = await preflight(root, 'companion')
    assert.equal(report.status, 'failed')
    const jobs = report.repositories[0].verification.jobs
    assert.equal(jobs[0].id, 'install'); assert.equal(jobs[0].status, 'failed')
    assert.match(await readFile(jobs[0].log, 'utf8'), /OUTDATED_LOCKFILE/)
    assert.equal(jobs.length, 1)
  })

  test('plans the complete maintained full/current workflow with no guessed test command list', async () => {
    const source = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
    for (const [historical, count] of [[true, 30], [false, 21]]) {
      const context = workflowContext({ historical })
      const jobs = compileWorkflow(source, context).filter(job => job.definition.if === undefined || expression(job.definition.if, context))
      assert.equal(jobs.flatMap(job => job.variants).length, count)
      assert.ok(jobs.some(job => job.id === 'build-test'))
    }
  })

  test('retains historical coverage for already-pushed feature changes in the develop review range', async () => {
    const root = await repository({ jobs: {
      'ci-scope': { steps: [{ run: 'node scripts/testing/ci-scope.mjs' }] },
      'build-test': { needs: 'ci-scope', steps: [{ run: 'true' }] },
    } })
    await put(root, 'scripts/testing/ci-scope.mjs', await readFile(new URL('../testing/ci-scope.mjs', import.meta.url)))
    commit(root)
    git(root, ['update-ref', 'refs/remotes/origin/develop', git(root, ['rev-parse', 'HEAD']).toString().trim()])
    git(root, ['checkout', '--quiet', '-b', 'fixture-feature'])
    await put(root, 'packages/api/migrations/000_fixture.sql', 'SELECT 1;\n'); commit(root)
    git(root, ['update-ref', 'refs/remotes/origin/fixture-feature', git(root, ['rev-parse', 'HEAD']).toString().trim()])
    const plan = await publicationPlan(root, 'oss')
    assert.equal(plan.historical, true)
    assert.notEqual(plan.ciBase, plan.input.base)
    const { report, reportPath } = await preflight(root)
    assert.equal(report.status, 'passed', JSON.stringify(report))
    await verifyReceipt(reportPath)
    git(root, ['update-ref', 'refs/remotes/origin/develop', git(root, ['rev-parse', 'HEAD']).toString().trim()])
    await assert.rejects(verifyReceipt(reportPath), /Stale/)
  })

  test('cannot certify hosted-only tests without the nested OSS CI participant', async () => {
    const root=await repository(null)
    const { report }=await preflight(root,'platform')
    assert.equal(report.status,'failed')
    assert.match(report.error,/requires its nested OSS CI participant/)
  })

  test('freezes the canonical KB context for actual platform checks and invalidates changed context', async () => {
    const parent = await directory()
    const scripts = Object.fromEntries(['verify:api-deploy', 'build', 'typecheck', 'test', 'smoke'].map(name => [name, 'echo passed']))
    scripts.test = 'node -e "require(\'node:assert/strict\').deepEqual(process.argv.slice(1),[\'--filter=./apps/*\',\'--filter=./packages/*\'])" --'
    scripts.check = 'node -e "require(\'node:assert/strict\').equal(require(\'node:fs\').readFileSync(\'../industry-brain/brian-kb/proof.md\',\'utf8\'),\'frozen\')"'
    const platform = await repository(null, { name: 'platform-fixture', private: true, scripts }, join(parent, 'platform'))
    const oss = await repository(simple('true'), undefined, join(platform, 'use-brian'))
    git(platform, ['add', 'use-brian']); commit(platform)
    const kb = await repository(null, undefined, join(parent, 'industry-brain/brian-kb'))
    await put(kb, 'proof.md', 'frozen'); commit(kb)
    const reportPath = join(await directory(), 'receipt.json')
    const repositories = [{ root: platform, kind: 'platform' }, { root: oss, kind: 'oss' }]
    const report = await runPreflight({ repositories, reportPath })
    assert.equal(report.status, 'passed', JSON.stringify(report))
    assert.equal(report.contexts.length, 1)
    await verifyReceipt(reportPath, repositories)
    await put(kb, 'proof.md', 'changed')
    await assert.rejects(verifyReceipt(reportPath), /context source changed/)
  })

  test('refuses to certify newly changed container definitions or unhandled executable companions', async () => {
    const root = await repository(simple('true'))
    await put(root, 'apps/example/Dockerfile', 'FROM scratch\n')
    await assert.rejects(publicationPlan(root, 'oss'), /maintained local validator/)
    await rm(join(root, 'package.json'))
    await put(root, 'verify.sh', 'exit 0\n')
    await assert.rejects(publicationPlan(root, 'companion'), /Executable companion/)
  })

  test('checks the outgoing documentation delta even though the disposable snapshot is committed', async () => {
    const root = await repository(null)
    await rm(join(root, 'package.json'))
    await put(root, 'changed.md', 'Trailing whitespace  \n')
    const { report } = await preflight(root, 'companion')
    assert.equal(report.status, 'failed')
    const failed = report.repositories[0].verification.jobs[0]
    assert.equal(failed.id, 'documentation')
    assert.match(await readFile(failed.log, 'utf8'), /trailing whitespace/)
  })
})
