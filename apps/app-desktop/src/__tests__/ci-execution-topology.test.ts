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
    expect(remainingCommand).toContain('--concurrency=4');
    expect(workflow.jobs['build-test'].needs).toEqual([
      'build-typecheck',
      'api-tests',
      'app-web-tests',
      'heavyweight-tests',
      'remaining-tests',
      'department-isolation',
    ]);
    expect(workflow.jobs['build-test'].if).toContain('always()');
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
