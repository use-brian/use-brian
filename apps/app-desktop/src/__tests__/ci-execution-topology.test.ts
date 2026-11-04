import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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
      workflow.jobs['api-tests'],
      workflow.jobs['app-web-tests'],
      workflow.jobs['heavyweight-tests'],
      workflow.jobs['remaining-tests'],
      workflow.jobs['ci-scope'],
      workflow.jobs['department-isolation-shards'],
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
    expect(remainingCommand).toContain('--concurrency=4');
    const embedded = workflow.jobs['embedded-database-tests'];
    expect(embedded.strategy.matrix.shard).toEqual([1, 2, 3]);
    expect(embedded.strategy['fail-fast']).toBe(false);
    const nodeTests = embedded.steps.find((step: { name?: string }) => step.name === 'Embedded database tests');
    expect(nodeTests.run).toContain('scripts/testing/embedded-database-tests.mjs ${{ matrix.shard }}');
    expect(embedded.steps.find((step: { name?: string }) => step.name === 'Runtime unit tests').if).toBe('matrix.shard == 3');
    const acceptance = workflow.jobs['department-isolation-shards'];
    expect(acceptance.strategy.matrix.shard).toContain('fromJSON(needs.ci-scope.outputs.shards)');
    expect(workflow.jobs['embedded-current-tests'].if).toBe("needs.ci-scope.outputs.historical == 'false'");
    expect(embedded.if).toBe("needs.ci-scope.outputs.historical == 'true'");
    expect(workflow.on.schedule).toHaveLength(1);
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(workflow.concurrency.group).toContain('nightly');
    expect(acceptance.strategy['fail-fast']).toBe(false);
    expect(acceptance.steps.find((step: { name?: string }) => step.name === 'Run no-credential acceptance').run)
      .toContain('--shard ${{ matrix.shard }}/${{ needs.ci-scope.outputs.total }}');
    expect(acceptance.steps.find((step: { uses?: string }) => step.uses === 'actions/upload-artifact@v4').with.name)
      .toContain('${{ matrix.shard }}');
    const aggregate = workflow.jobs['department-isolation'];
    expect(aggregate.needs).toEqual(['ci-scope', 'department-isolation-shards']);
    expect(aggregate.if).toContain('always()');
    expect(aggregate.steps.find((step: { name?: string }) => step.name === 'Verify complete acceptance evidence').run)
      .toContain('--merge');
    expect(workflow.jobs['build-test'].needs).toEqual([
      'ci-scope',
      'embedded-current-tests',
      'build-typecheck',
      'api-tests',
      'app-web-tests',
      'heavyweight-tests',
      'remaining-tests',
      'embedded-database-tests',
      'department-isolation',
    ]);
    expect(workflow.jobs['build-test'].if).toContain('always()');
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
