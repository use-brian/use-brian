import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load: (text: string) => any };
const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url));

describe('[COMP:ci/execution-topology] bounded CI test execution', () => {
  it('isolates heavyweight suites and keeps one aggregate release gate', () => {
    const workflow = yaml.load(readFileSync(join(sourceRoot, '.github/workflows/ci.yml'), 'utf8'));
    const executionJobs = [
      workflow.jobs['build-typecheck'],
      workflow.jobs['database-test-dependencies'],
      workflow.jobs['api-tests'],
      workflow.jobs['app-web-tests'],
      workflow.jobs['offline-continuity'],
      workflow.jobs['heavyweight-tests'],
      workflow.jobs['remaining-tests'],
      workflow.jobs['ci-scope'],
      workflow.jobs['department-isolation-shards'],
      workflow.jobs['calendar-isolation'],
      workflow.jobs['department-isolation'],
    ];
    for (const job of executionJobs) {
      expect(job.if).toContain("github.event_name != 'pull_request'");
      expect(job.if).toContain("github.head_ref != 'develop'");
      expect(job.if).toContain('github.event.pull_request.head.repo.full_name != github.repository');
    }
    expect(workflow.jobs['heavyweight-tests'].strategy.matrix.package).toEqual([
      '@use-brian/core',
      '@use-brian/app-desktop',
    ]);
    expect(workflow.jobs['api-tests'].strategy.matrix.shard).toEqual([
      '1/4',
      '2/4',
      '3/4',
      '4/4',
    ]);
    const apiCommand = workflow.jobs['api-tests'].steps.find(
      (step: { name?: string }) => step.name === 'Unit tests',
    ).run;
    expect(apiCommand).toContain('vitest run --shard=${{ matrix.shard }}');
    expect(workflow.jobs['app-web-tests'].strategy.matrix.shard).toEqual([
      '1/4',
      '2/4',
      '3/4',
      '4/4',
    ]);
    const appWebCommand = workflow.jobs['app-web-tests'].steps.find(
      (step: { name?: string }) => step.name === 'Unit tests',
    ).run;
    expect(appWebCommand).toContain('vitest run --shard=${{ matrix.shard }}');
    const heavyCommand = workflow.jobs['heavyweight-tests'].steps.find(
      (step: { name?: string }) => step.name === 'Unit tests',
    ).run;
    expect(heavyCommand).toContain('turbo run test');
    expect(heavyCommand).toContain('--filter="${{ matrix.package }}"');
    const remainingCommand = workflow.jobs['remaining-tests'].steps.find(
      (step: { name?: string }) => step.name === 'Unit tests',
    ).run;
    expect(remainingCommand).toContain("--filter='!@use-brian/api'");
    expect(remainingCommand).toContain("--filter='!@use-brian/core'");
    expect(remainingCommand).toContain("--filter='!app-web'");
    expect(remainingCommand).toContain("--filter='!@use-brian/app-desktop'");
    expect(remainingCommand).toContain("--filter='!@use-brian/api-open'");
    // The collector starts six real hook processes. Keep package fan-out at
    // the root unit command's limit so sibling builds cannot starve them.
    expect(remainingCommand).toContain('--concurrency=1');
    const embedded = workflow.jobs['embedded-database-tests'];
    expect(embedded.strategy.matrix.include).toEqual([
      { group: 'owner-legacy', timeoutMinutes: 25 },
      { group: 'owner-fresh', timeoutMinutes: 15 },
      { group: 'owner-cutover', timeoutMinutes: 15 },
      { group: 'owner-successor', timeoutMinutes: 15 },
      { group: 'owner-prerequisites', timeoutMinutes: 10 },
      { group: 'session', timeoutMinutes: 15 },
      { group: 'publication-upgrade', timeoutMinutes: 15 },
      { group: 'remaining', timeoutMinutes: 10 },
    ]);
    expect(embedded['timeout-minutes']).toBe('${{ matrix.timeoutMinutes }}');
    expect(embedded.strategy['fail-fast']).toBe(false);
    const nodeTests = embedded.steps.find((step: { name?: string }) => step.name === 'Embedded database tests');
    expect(nodeTests.run).toContain('scripts/testing/embedded-database-tests.mjs ${{ matrix.group }}');
    expect(embedded.steps.find((step: { name?: string }) => step.name === 'Runtime unit tests').if).toBe("matrix.group == 'remaining'");
    const acceptance = workflow.jobs['department-isolation-shards'];
    expect(acceptance.strategy.matrix).toContain('fromJSON(needs.ci-scope.outputs.matrix)');
    expect(workflow.jobs['ci-scope'].outputs.matrix).toBe('${{ steps.scope.outputs.matrix }}');
    expect(workflow.jobs['embedded-current-tests'].if).toBe("needs.ci-scope.outputs.historical == 'false'");
    expect(workflow.jobs['embedded-current-tests']['timeout-minutes']).toBe(20);
    expect(embedded.if).toBe("needs.ci-scope.outputs.historical == 'true'");
    expect(workflow.on.schedule).toHaveLength(1);
    expect(workflow.on.workflow_dispatch.inputs.compare_calendar_arm).toMatchObject({ type: 'boolean', default: false });
    expect(workflow.concurrency.group).toContain('nightly');
    expect(acceptance.strategy['fail-fast']).toBe(false);
    expect(acceptance['runs-on']).toBe('${{ matrix.runner }}');
    expect(acceptance.steps.find((step: { name?: string }) => step.name === 'Run no-credential acceptance').run)
      .toContain('--shard ${{ matrix.shard }}/${{ needs.ci-scope.outputs.total }}');
    expect(acceptance.steps.find((step: { uses?: string }) => step.uses === 'actions/upload-artifact@v4').with.name)
      .toBe('${{ matrix.artifactName }}');
    const aggregate = workflow.jobs['department-isolation'];
    expect(aggregate.needs).toEqual(['ci-scope', 'calendar-isolation', 'department-isolation-shards']);
    expect(aggregate.if).toContain('always()');
    expect(aggregate.steps.find((step: { uses?: string }) => step.uses === 'actions/download-artifact@v4').with.pattern)
      .toBe('department-isolation-shard-*');
    expect(aggregate.steps.map((step: { uses?: string; run?: string }) => step.uses ?? step.run).join('\n'))
      .not.toContain('pnpm');
    expect(aggregate.steps.find((step: { name?: string }) => step.name === 'Verify complete acceptance evidence').run)
      .toContain('--merge');
    const requireShards = aggregate.steps.find((step: { name?: string }) => step.name === 'Require every acceptance shard').run;
    for (const [SHARD_RESULT, CALENDAR_RESULT, status] of [
      ['success', 'success', 0], ['failure', 'success', 1], ['success', 'failure', 1], ['success', 'skipped', 1],
    ] as const) {
      expect(spawnSync('bash', ['-c', requireShards], { env: { ...process.env, SHARD_RESULT, CALENDAR_RESULT } }).status).toBe(status);
    }
    expect(workflow.jobs['build-test'].needs).toEqual([
      'ci-scope',
      'database-test-dependencies',
      'embedded-current-tests',
      'build-typecheck',
      'api-tests',
      'app-web-tests',
      'offline-continuity',
      'heavyweight-tests',
      'remaining-tests',
      'embedded-database-tests',
      'department-isolation',
    ]);
    expect(workflow.jobs['build-test'].if).toContain('always()');
  });

  it('keeps suites excluded from ordinary shards mandatory in their focused lanes', async () => {
    const { OFFLINE_CONTINUITY_FILES, unitTestExclusions } = await import(new URL('../../../../scripts/testing/unit-partition.mjs', import.meta.url).href);
    const workflow = yaml.load(readFileSync(join(sourceRoot, '.github/workflows/ci.yml'), 'utf8'));
    const build = workflow.jobs['build-typecheck'];
    const fast = build.steps.find((step: { run?: string }) => step.run === 'pnpm check:fast --all');
    expect(fast).toBeDefined();
    expect(fast.if).toBeUndefined();
    expect(fast['continue-on-error']).not.toBe(true);
    const buildIndex = build.steps.findIndex((step: { run?: string }) => step.run === 'pnpm build');
    expect(build.steps.indexOf(fast)).toBeLessThan(buildIndex);
    expect(unitTestExclusions('packages/api', 'ordinary')).toContain('src/routes/__tests__/teamspaces-contract.test.mjs');
    expect(unitTestExclusions('packages/api', '')).toEqual([]);
    const lane = workflow.jobs['offline-continuity'];
    expect(lane.env?.BRIAN_TEST_PARTITION).toBeUndefined();
    expect(workflow.jobs['department-isolation-shards'].env?.BRIAN_TEST_PARTITION).toBeUndefined();
    for (const job of ['api-tests', 'app-web-tests', 'heavyweight-tests']) {
      expect(workflow.jobs[job].steps.find((step: { name?: string }) => step.name === 'Unit tests').env.BRIAN_TEST_PARTITION).toBe('ordinary');
    }
    expect(lane['continue-on-error']).not.toBe(true);
    const commands = lane.steps.filter((step: { run?: string }) => step.run?.includes('vitest run'));
    expect(commands).toHaveLength(2);
    for (const step of commands) {
      expect(step.if).toBeUndefined();
      expect(step['continue-on-error']).not.toBe(true);
      expect(step.run).not.toMatch(/--passWithNoTests|--testNamePattern|\|\|\s*true/);
      const directory = step.run.includes('--filter app-web ') ? 'apps/app-web' : 'apps/app-desktop';
      const files = step.run.match(/(?:src|desktop)\/[^\s]+\.test\.tsx?/g) ?? [];
      expect(files.length).toBeGreaterThan(0);
      expect([...files].sort()).toEqual([...OFFLINE_CONTINUITY_FILES[directory]].sort());
      expect(unitTestExclusions(directory, 'ordinary')).toEqual(expect.arrayContaining(files));
      expect(unitTestExclusions(directory, '')).toEqual([]);
      for (const file of files) expect(readFileSync(join(sourceRoot, directory, file), 'utf8')).toContain('[COMP:');
    }
    const app = commands[0].run;
    for (const suite of ['app-session.test', 'auth-fetch.test', 'offline-bootstrap.test',
      'offline-pages.test', 'offline-writes.test', 'use-offline-sync.test',
      'recorder-engine-live.test', 'recording-player-context.test']) expect(app).toContain(suite);
    for (const suite of ['desktop-auth.test', 'window-policy.test', 'desktop-token-store.test', 'desktop-packaging.test']) {
      expect(commands[1].run).toContain(suite);
    }
    expect(workflow.jobs['build-test'].steps[0].env.OFFLINE_CONTINUITY_RESULT)
      .toBe('${{ needs.offline-continuity.result }}');
    const turbo = JSON.parse(readFileSync(join(sourceRoot, 'turbo.json'), 'utf8'));
    expect(turbo.tasks.test.env).toContain('BRIAN_TEST_PARTITION');
    expect(turbo.tasks.test.inputs).toContain('$TURBO_ROOT$/scripts/testing/unit-partition.mjs');
    expect(turbo.tasks.test.inputs).toContain('$TURBO_ROOT$/packages/shared/src/department-isolation-coverage.ts');
  });

  it('restores same-run dependencies without spending acceptance time recompiling', () => {
    const workflow = yaml.load(readFileSync(join(sourceRoot, '.github/workflows/ci.yml'), 'utf8'));
    const build = workflow.jobs['database-test-dependencies'];
    const acceptance = workflow.jobs['department-isolation-shards'];
    expect(build.needs).toBeUndefined();
    expect(workflow.jobs['build-typecheck'].needs).toBeUndefined();
    expect(acceptance['timeout-minutes']).toBe('${{ matrix.timeoutMinutes }}');
    const step = (job: any, name: string) => job.steps.find((item: { name?: string }) => item.name === name);
    expect(step(build, 'Build package dependencies for database tests').run).toBe("pnpm exec turbo run build --filter='./packages/*'");
    expect(workflow.jobs['build-test'].steps[0].env.DATABASE_BUILD_RESULT).toBe('${{ needs.database-test-dependencies.result }}');
    const upload = step(build, 'Retain database test dependencies');
    const download = step(acceptance, 'Download database test dependencies');
    expect(upload.uses).toBe('actions/upload-artifact@v4');
    expect(download.uses).toBe('actions/download-artifact@v4');
    expect(upload.with.name).toBe('database-test-dependencies-${{ github.sha }}');
    expect(download.with.name).toBe(upload.with.name);
    expect(upload.with['if-no-files-found']).toBe('error');
    expect(download.with.path).toBe('${{ runner.temp }}');
    for (const consumer of [acceptance, workflow.jobs['embedded-current-tests'], workflow.jobs['embedded-database-tests']]) {
      expect(consumer.needs).toEqual(['ci-scope', 'database-test-dependencies']);
      expect(step(consumer, 'Download database test dependencies')).toEqual(download);
      expect(step(consumer, 'Restore database test dependencies')).toEqual(step(acceptance, 'Restore database test dependencies'));
      expect(consumer.steps.some((item: { run?: string }) => item.run?.includes('turbo run build'))).toBe(false);
    }
    for (const transfer of [upload, download]) {
      expect(transfer['continue-on-error']).not.toBe(true);
      expect(transfer.if).toBeUndefined();
    }

    const directory = mkdtempSync(join(tmpdir(), 'ci-dependency-transfer-'));
    const producer = join(directory, 'producer'), consumer = join(directory, 'consumer');
    const runnerTemp = join(directory, 'artifacts');
    for (const path of [producer, consumer, runnerTemp]) mkdirSync(path);
    const outputs = ['packages/api/dist/routes/nested.js', 'packages/core/dist/skills/builtin/SKILL.md'];
    try {
      for (const path of outputs) {
        mkdirSync(join(producer, path, '..'), { recursive: true });
        writeFileSync(join(producer, path), `compiled ${path}`, { mode: 0o755 });
      }
      const run = (script: string, cwd: string) => spawnSync('bash', ['-e', '-c', script], {
        cwd, env: { ...process.env, RUNNER_TEMP: runnerTemp }, encoding: 'utf8',
      });
      const archive = step(build, 'Archive database test dependencies').run;
      const restore = step(acceptance, 'Restore database test dependencies').run;
      expect(run(archive, producer).status).toBe(0);
      expect(run(restore, consumer).status).toBe(0);
      for (const path of outputs) {
        expect(readFileSync(join(consumer, path), 'utf8')).toBe(`compiled ${path}`);
        expect(statSync(join(consumer, path)).mode & 0o777).toBe(0o755);
      }
      rmSync(join(runnerTemp, 'database-test-dependencies.tgz'));
      expect(run(restore, consumer).status).not.toBe(0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('starts Calendar after scope using its API test dependencies and the shared acceptance contract', () => {
    const workflow = yaml.load(readFileSync(join(sourceRoot, '.github/workflows/ci.yml'), 'utf8'));
    const calendar = workflow.jobs['calendar-isolation'];
    const acceptance = workflow.jobs['department-isolation-shards'];
    const step = (job: any, name: string) => job.steps.find((item: { name?: string }) => item.name === name);
    expect(calendar.needs).toBe('ci-scope');
    expect(calendar.strategy.matrix).toContain('fromJSON(needs.ci-scope.outputs.calendar)');
    expect(workflow.jobs['ci-scope'].outputs.calendar).toBe('${{ steps.scope.outputs.calendar }}');
    expect(step(calendar, 'Build Calendar test dependencies').run).toBe("pnpm exec turbo run build --filter='@use-brian/api^...'");
    expect(step(calendar, 'Download database test dependencies')).toBeUndefined();
    for (const name of ['Install PostgreSQL 18 with required extensions', 'Install dependencies', 'Run no-credential acceptance', 'Upload acceptance report']) {
      expect(step(calendar, name)).toEqual(step(acceptance, name));
    }
    expect(step(workflow.jobs['ci-scope'], 'Retain proposed change impact (report-only)')['continue-on-error']).toBe(true);
  });

  it('fails the aggregate for every unsuccessful selected lane and unknown selection', () => {
    const workflow = yaml.load(readFileSync(join(sourceRoot, '.github/workflows/ci.yml'), 'utf8'));
    const script = workflow.jobs['build-test'].steps[0].run;
    const base = Object.fromEntries(Object.keys(workflow.jobs['build-test'].steps[0].env).map(key => [key, 'success']));
    for (const historical of ['true', 'false']) {
      const env: Record<string, string | undefined> = { ...process.env, ...base, HISTORICAL: historical,
        EMBEDDED_CURRENT_RESULT: historical === 'true' ? 'skipped' : 'success',
        EMBEDDED_DATABASE_TESTS_RESULT: historical === 'true' ? 'success' : 'skipped' };
      expect(spawnSync('bash', ['-c', script], { env }).status).toBe(0);
      for (const key of Object.keys(base).filter(key => key !== 'HISTORICAL' && env[key] === 'success')) {
        for (const result of ['failure', 'cancelled', 'skipped', '']) {
          expect(spawnSync('bash', ['-c', script], { env: { ...env, [key]: result } }).status).not.toBe(0);
        }
      }
      expect(spawnSync('bash', ['-c', script], { env: { ...env, HISTORICAL: '' } }).status).not.toBe(0);
    }
  });

  it('bounds internal Vitest fan-out for subprocess and socket-heavy suites', () => {
    expect(readFileSync(join(sourceRoot, 'apps/app-desktop/vitest.config.ts'), 'utf8')).toContain(
      'fileParallelism: process.env.CI !== "true"',
    );
    expect(readFileSync(join(sourceRoot, 'packages/api/vitest.config.ts'), 'utf8')).toContain(
      "maxWorkers: process.env.CI === 'true' ? 1 : undefined",
    );
  });
});
