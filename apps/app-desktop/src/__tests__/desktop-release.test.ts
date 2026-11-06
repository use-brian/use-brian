import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load: (text: string) => any };
const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const sha = 'a'.repeat(40), older = 'b'.repeat(40);
const dirs: string[] = [];

function fixture(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-release-test-'));
  dirs.push(root);
  const app = join(root, 'apps/app-desktop');
  const output = join(app, 'release');
  mkdirSync(join(app, 'scripts'), { recursive: true });
  mkdirSync(output);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(dirname(require.resolve('js-yaml/package.json')), join(root, 'node_modules/js-yaml'), 'junction');
  copyFileSync(join(sourceRoot, 'apps/app-desktop/scripts/release.mjs'), join(app, 'scripts/release.mjs'));
  copyFileSync(join(sourceRoot, 'scripts/configure-desktop-release.sh'), join(root, 'scripts/configure-desktop-release.sh'));
  writeFileSync(join(app, 'package.json'), JSON.stringify({ version: '0.0.12' }));
  const statePath = join(root, 'state.json');
  const state = {
    sha, main: sha, ci: 'success', changes: 'apps/app-web/src/components/feed/post.tsx',
    releases: [], tags: [], policies: '', environments: '', custom: true,
    ...overrides,
  };
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(join(root, 'bin/git'), `#!/usr/bin/env node
const fs = require('node:fs'); const s = JSON.parse(fs.readFileSync(process.env.RELEASE_TEST_STATE));
const a = process.argv.slice(2);
if (a[0] === 'rev-parse') console.log(s.sha);
else if (a[0] === 'merge-base') process.exit(s.ancestryFailure ? 1 : 0);
else if (a[0] === 'diff') process.stdout.write(s.changes);
else process.exit(2);
`, { mode: 0o755 });
  writeFileSync(join(root, 'bin/gh'), `#!/usr/bin/env node
const fs = require('node:fs'), crypto = require('node:crypto'), path = require('node:path');
const statePath = process.env.RELEASE_TEST_STATE, s = JSON.parse(fs.readFileSync(statePath));
const a = process.argv.slice(2), out = (v) => console.log(JSON.stringify(v));
const option = (name) => a[a.indexOf(name) + 1];
s.calls = [...(s.calls || []), a];
const save = () => fs.writeFileSync(statePath, JSON.stringify(s));
save();
if (a[0] === 'api') {
  const route = a.find(x => x.startsWith('repos/')).replace('repos/use-brian/use-brian', '');
  if (!route) console.log('true');
  else if (route === '/git/ref/heads/main') out({ object: { sha: s.main } });
  else if (route.startsWith('/actions/workflows/')) out({ workflow_runs: [{ head_sha: s.sha,
    head_branch: 'main', head_repository: { full_name: s.fork ? 'example/fork' : 'use-brian/use-brian' },
    event: s.ciEvent || 'push', status: 'completed', conclusion: s.ci, run_number: 2, run_attempt: 1 }] });
  else if (route.startsWith('/releases?')) out([s.releases]);
  else if (route.startsWith('/tags?')) out([s.tags]);
  else if (route.startsWith('/releases/tags/')) out(s.releases.find(r => r.tag_name === route.split('/').at(-1)));
  else if (route.startsWith('/releases/')) out(s.releases.find(r => String(r.id) === route.split('/').at(-1)));
  else if (route.startsWith('/commits/')) out({ sha: s.sha });
  else if (route === '/git/refs') s.tags.push({ name: a.find(x => x.startsWith('ref=')).split('/').at(-1), commit: {sha: s.sha} });
  else if (route === '/environments') console.log(s.environments);
  else if (route.endsWith('/deployment-branch-policies')) {
    if (a.includes('POST')) s.policies = 'main\\tbranch';
    else console.log(s.policies);
  } else if (route === '/environments/desktop-release') {
    if (a.includes('PUT')) { fs.readFileSync(0); s.environments = 'desktop-release'; }
    else console.log(String(s.custom));
  } else { console.error('Unexpected API ' + route); process.exit(2); }
} else if (a[0] === 'release') {
  const r = s.releases.find(r => r.tag_name === a[2]);
  if (a[1] === 'download') out(s.previous);
  else if (a[1] === 'create') s.releases.push({ id: 1, tag_name: a[2], target_commitish: option('--target'), draft: true, prerelease: false, assets: [] });
  else if (a[1] === 'upload') {
    if (s.failUpload) { save(); process.exit(3); }
    r.assets = a.slice(3, a.indexOf('--repo')).map(file => {
      const b = fs.readFileSync(file);
      return { name: path.basename(file), state: 'uploaded', size: b.length,
        digest: 'sha256:' + crypto.createHash('sha256').update(b).digest('hex') };
    });
    if (s.badDigest) r.assets[0].digest = 'sha256:wrong';
    if (s.moveDuringUpload) s.main = 'c'.repeat(40);
  } else if (a[1] === 'edit') { r.draft = false; r.prerelease = false; }
  else process.exit(4);
} else if (a[0] === 'secret') {
  if (s.failSecret === a[2]) process.exit(5);
  s.secrets = {...s.secrets, [a[2]]: fs.readFileSync(0, 'utf8')};
} else if (a[0] === 'variable') s.enabled = true;
else process.exit(6);
save();
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    RELEASE_TEST_STATE: statePath, GITHUB_OUTPUT: join(root, 'outputs') };
  const run = (...args: string[]) => spawnSync(process.execPath, [join(app, 'scripts/release.mjs'), ...args], { env, encoding: 'utf8' });
  const readState = () => JSON.parse(readFileSync(statePath, 'utf8'));
  const patchState = (value: Record<string, unknown>) => writeFileSync(statePath, JSON.stringify({ ...readState(), ...value }));
  const prepare = () => {
    writeFileSync(join(app, 'package.json'), JSON.stringify({ version: '0.0.13' }));
    writeFileSync(join(output, 'usebrian.zip'), 'fictional zip bytes');
    writeFileSync(join(output, 'usebrian.dmg'), 'signed fictional dmg bytes');
    writeFileSync(join(output, 'usebrian.zip.blockmap'), 'fictional blockmap');
    const zip = readFileSync(join(output, 'usebrian.zip'));
    const sha512 = createHash('sha512').update(zip).digest('base64');
    writeFileSync(join(output, 'latest-mac.yml'), JSON.stringify({ version: '0.0.13', path: 'usebrian.zip', sha512,
      files: [{ url: 'usebrian.zip', sha512, size: zip.length }, { url: 'usebrian.dmg', sha512: 'before-signing', size: 1 }] }));
    const macPrepared = run('prepare', '0.0.13', sha);
    if (macPrepared.status !== 0) return macPrepared;
    writeFileSync(join(output, 'usebrian.exe'), 'fictional Windows installer bytes');
    writeFileSync(join(output, 'usebrian.exe.blockmap'), 'fictional Windows blockmap');
    const exe = readFileSync(join(output, 'usebrian.exe'));
    const exeSha512 = createHash('sha512').update(exe).digest('base64');
    writeFileSync(join(output, 'latest.yml'), JSON.stringify({ version: '0.0.13', path: 'usebrian.exe', sha512: exeSha512,
      files: [{ url: 'usebrian.exe', sha512: exeSha512, size: exe.length }] }));
    return run('prepare-windows', '0.0.13', sha);
  };
  return { root, app, output, env, run, readState, patchState, prepare };
}

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('[COMP:app-desktop/release] automated delivery', () => {
  it('advances past the source version, published releases, reserved drafts and tags', () => {
    const f = fixture({ releases: [{ tag_name: 'v0.0.11', assets: [], draft: false },
      { tag_name: 'v0.0.13', assets: [], draft: true }], tags: [{ name: 'v0.0.14' }] });
    const result = f.run('plan', sha);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ release: true, sha, version: '0.0.15' });
  });

  it.each(['apps/app-web/desktop/app.tsx', 'apps/app-web/src/feed.tsx', 'packages/chat-ui/src/composer.tsx',
    'apps/firefox-companion/src/index.ts', 'pnpm-lock.yaml', 'scripts/package-desktop.sh'])(
    'includes every unreleased bundled input: %s', (changes) => {
      const f = fixture({ changes, previous: { schema: 1, sha: older, version: '0.0.11', platform: 'darwin', arch: 'arm64' },
        releases: [{ tag_name: 'v0.0.11', draft: false, assets: [{ name: 'latest-mac.yml' }, { name: 'desktop-release.json' }] }] });
      expect(JSON.parse(f.run('plan', sha).stdout).release).toBe(true);
    });

  it.each(['', 'docs/example.md', 'apps/app-desktop/README.md'])('skips already shipped or documentation-only inputs: %s', (changes) => {
    const f = fixture({ changes, previous: { schema: 1, sha: older, version: '0.0.11', platform: 'darwin', arch: 'arm64' },
      releases: [{ tag_name: 'v0.0.11', draft: false, assets: [{ name: 'latest-mac.yml' }, { name: 'desktop-release.json' }] }] });
    expect(JSON.parse(f.run('plan', sha).stdout).release).toBe(false);
  });

  it.each([{ main: older }, { ci: 'failure' }, { fork: true }, { ciEvent: 'pull_request' }])('refuses untested, obsolete, or untrusted production: %j', (state) => {
    const f = fixture(state);
    expect(f.run('plan', sha).status).not.toBe(0);
    expect(f.readState().calls.some((a: string[]) => a.includes('create'))).toBe(false);
  });

  it('plans builds before CI finishes but still refuses publication and obsolete inputs', () => {
    const f = fixture({ ci: null });
    expect(f.run('plan-build', sha).status).toBe(0);
    expect(f.readState().calls.some((a: string[]) => a.includes('create'))).toBe(false);
    expect(f.prepare().status).toBe(0);
    expect(f.run('publish', '0.0.13', sha).status).not.toBe(0);
    expect(f.readState().releases).toEqual([]);
    f.patchState({ main: older });
    expect(f.run('plan-build', sha).status).not.toBe(0);
  });

  it('waits through absent, queued and running CI, then accepts only success', async () => {
    const modulePath = fileURLToPath(new URL('../../scripts/release.mjs', import.meta.url));
    const { waitForProductionCi } = await import(modulePath);
    const states = [undefined, { status: 'queued' }, { status: 'in_progress' },
      { status: 'completed', conclusion: 'success' }];
    let pauses = 0;
    await waitForProductionCi(sha, { inspect: () => states.shift(), pause: async () => { pauses++; }, log: () => {} });
    expect(pauses).toBe(3);
    for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out', 'neutral', null]) {
      await expect(waitForProductionCi(sha, { inspect: () => ({ status: 'completed', conclusion }),
        pause: async () => { throw new Error('must not poll terminal failure'); }, log: () => {} }))
        .rejects.toThrow('Production CI did not succeed');
    }
    await expect(waitForProductionCi(sha, { inspect: () => { throw new Error('Production moved'); }, log: () => {} }))
      .rejects.toThrow('Production moved');
  });

  it('repairs only the post-signing DMG hash and detects a tampered ZIP', () => {
    const f = fixture();
    const prepared = f.prepare();
    expect(prepared.status, prepared.stderr).toBe(0);
    const feed = yaml.load(readFileSync(join(f.output, 'latest-mac.yml'), 'utf8'));
    expect(feed.files[1].sha512).toBe(createHash('sha512').update(readFileSync(join(f.output, 'usebrian.dmg'))).digest('base64'));
    writeFileSync(join(f.output, 'usebrian.zip'), 'tampered');
    expect(f.run('prepare', '0.0.13', sha).stderr).toContain('ZIP checksum');
    expect(f.run('verify', '0.0.13', sha).stderr).toContain('changed after verification');
  });

  it('stamps one planned version and rejects a tampered Windows installer', () => {
    const f = fixture();
    expect(f.run('stamp', '0.0.13', sha).status).toBe(0);
    expect(JSON.parse(readFileSync(join(f.app, 'package.json'), 'utf8')).version).toBe('0.0.13');
    expect(f.prepare().status).toBe(0);
    writeFileSync(join(f.output, 'usebrian.exe'), 'tampered');
    expect(f.run('prepare-windows', '0.0.13', sha).stderr).toContain('Windows updater checksum');
    expect(f.run('verify', '0.0.13', sha).stderr).toContain('changed after verification');
  });

  // Four CLI runs launch many real Node subprocesses; allow for shared CI CPU.
  it('keeps failed uploads hidden and publishes only after stored digests match', () => {
    const f = fixture({ failUpload: true });
    expect(f.prepare().status).toBe(0);
    expect(f.run('publish', '0.0.13', sha).status).not.toBe(0);
    expect(f.readState().releases[0].draft).toBe(true);
    expect(f.readState().tags).toContainEqual({ name: 'v0.0.13', commit: { sha } });
    f.patchState({ failUpload: false });
    const result = f.run('publish', '0.0.13', sha);
    expect(result.status, result.stderr).toBe(0);
    expect(f.readState().releases[0]).toMatchObject({ target_commitish: sha, draft: false });
    const calls = f.readState().calls;
    const count = calls.filter((a: string[]) => a[0] === 'release' && a[1] === 'upload').length;
    expect(f.run('publish', '0.0.13', sha).status).toBe(0);
    expect(f.readState().calls.filter((a: string[]) => a[0] === 'release' && a[1] === 'upload')).toHaveLength(count);
  }, 30_000);

  it.each([{ badDigest: true }, { moveDuringUpload: true }])('never promotes an invalid or superseded upload: %j', (state) => {
    const f = fixture(state);
    expect(f.prepare().status).toBe(0);
    expect(f.run('publish', '0.0.13', sha).status).not.toBe(0);
    expect(f.readState().releases[0].draft).toBe(true);
  });

  it('refuses to replace a newer public release', () => {
    const f = fixture({ releases: [{ tag_name: 'v0.1.0', draft: false, prerelease: false }] });
    expect(f.prepare().status).toBe(0);
    expect(f.run('publish', '0.0.13', sha).stderr).toContain('refusing to move latest backwards');
  });

  it('refuses a version tag that belongs to different source code', () => {
    const f = fixture({ tags: [{ name: 'v0.0.13', commit: { sha: older } }] });
    expect(f.prepare().status).toBe(0);
    expect(f.run('publish', '0.0.13', sha).stderr).toContain('reserved for another source SHA');
    expect(f.readState().releases).toEqual([]);
  });

  it('builds workspace exports after installation and before desktop tests', () => {
    const workflow = yaml.load(readFileSync(join(sourceRoot, '.github/workflows/desktop-release.yml'), 'utf8'));
    const commands = workflow.jobs.build_macos.steps.map((step: { run?: string }) => step.run);
    const install = commands.indexOf('pnpm install --frozen-lockfile');
    const dependencies = commands.indexOf('pnpm --filter "@use-brian/app-desktop^..." run build');
    const tests = commands.indexOf('pnpm --filter @use-brian/app-desktop test');
    expect(install).toBeGreaterThanOrEqual(0);
    expect(dependencies).toBeGreaterThan(install);
    expect(tests).toBeGreaterThan(dependencies);
    const windowsCommands = workflow.jobs.build_windows.steps.map((step: { run?: string }) => step.run);
    expect(windowsCommands.findIndex((command: string) => command?.includes(' stamp '))).toBeGreaterThan(
      windowsCommands.indexOf('pnpm install --frozen-lockfile'));
    expect(windowsCommands.indexOf('pnpm --filter @use-brian/app-desktop package:win')).toBeGreaterThanOrEqual(0);
    expect(windowsCommands.findIndex((command: string) => command?.includes('prepare-windows'))).toBeGreaterThan(
      windowsCommands.indexOf('pnpm --filter @use-brian/app-desktop package:win'));
  });

  it('keeps workflow credentials and artifacts behind the production CI gate', () => {
    const workflow = yaml.load(readFileSync(join(sourceRoot, '.github/workflows/desktop-release.yml'), 'utf8'));
    expect(workflow.on.push).toEqual({ branches: ['main'] });
    expect(workflow.on.workflow_run).toBeUndefined();
    expect(workflow.jobs.plan.if).toContain("github.repository == 'use-brian/use-brian'");
    expect(workflow.jobs.plan.if).toContain("github.ref == 'refs/heads/main'");
    expect(workflow.jobs.plan.if).toContain("github.event_name == 'push'");
    expect(workflow.jobs.plan.steps.find((s: any) => s.id === 'plan').run).toContain(' plan-build ');
    expect(workflow.jobs.build_macos.needs).toBe('plan');
    expect(workflow.jobs.build_windows.needs).toBe('plan');
    expect(workflow.jobs.await_ci.needs).toBe('plan');
    expect(workflow.jobs.await_ci.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(workflow.jobs.await_ci.steps.some((s: any) => s.run?.includes(' wait-ci '))).toBe(true);
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    expect(workflow.jobs.build_macos.environment).toBe('desktop-release');
    expect(workflow.jobs.build_macos.permissions.contents).toBe('read');
    expect(workflow.jobs.build_windows.permissions.contents).toBe('read');
    expect(workflow.jobs.publish.permissions.contents).toBe('write');
    expect(workflow.jobs.publish.needs).toEqual(['plan', 'build_macos', 'build_windows', 'await_ci']);
    expect(JSON.stringify(workflow.jobs.build_windows)).not.toContain('secrets.');
    expect(JSON.stringify(workflow.jobs.publish)).not.toContain('secrets.');
    expect(JSON.stringify(workflow)).not.toContain('pull_request_target');
    const downloads = workflow.jobs.publish.steps.filter((s: any) => s.uses?.startsWith('actions/download-artifact'));
    expect(downloads).toHaveLength(2);
    expect(downloads.every((download: any) => download.with['run-id'] === undefined)).toBe(true);
    expect(downloads.map((download: any) => download.with.name)).toEqual([
      'desktop-release-macos-${{ needs.plan.outputs.sha }}',
      'desktop-release-windows-${{ needs.plan.outputs.sha }}',
    ]);
    expect(workflow.jobs.build_macos.steps.some((s: any) => s.run?.includes('--arm64'))).toBe(true);
  });

  it.each([false, true])('sets only five secrets and enables last (failed secret: %s)', (fail) => {
    const f = fixture({ failSecret: fail ? 'APPLE_ID' : '' });
    const cert = join(f.root, 'signing certificate.p12');
    writeFileSync(cert, 'fictional-certificate');
    const values = { CSC_LINK: cert, CSC_KEY_PASSWORD: 'fictional-password', APPLE_ID: 'release@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'fictional-app-password', APPLE_TEAM_ID: 'EXAMPLETEAM', GH_TOKEN: 'do-not-upload' };
    writeFileSync(join(f.root, '.env.desktop'), Object.entries(values).map(([key, value]) => `${key}='${value}'`).join('\n'));
    const result = spawnSync('bash', [join(f.root, 'scripts/configure-desktop-release.sh')], { env: f.env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(fail ? 5 : 0);
    expect(f.readState().enabled).toBe(fail ? undefined : true);
    expect(f.readState().secrets.GH_TOKEN).toBeUndefined();
    expect(result.stdout + result.stderr).not.toContain('fictional-password');
    if (!fail) {
      expect(Object.keys(f.readState().secrets)).toHaveLength(5);
      expect(Buffer.from(f.readState().secrets.CSC_LINK, 'base64').toString()).toBe('fictional-certificate');
      expect(f.readState().policies).toBe('main\tbranch');
      expect(f.readState().calls.at(-1)[0]).toBe('variable');
    }
  });

  it('preserves existing environment protections and refuses broader branch access', () => {
    const f = fixture({ environments: 'desktop-release', policies: 'develop\tbranch' });
    const env = { ...f.env, CSC_LINK: Buffer.from('fictional-certificate').toString('base64'),
      CSC_KEY_PASSWORD: 'fixture', APPLE_ID: 'release@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'fixture', APPLE_TEAM_ID: 'EXAMPLETEAM' };
    const result = spawnSync('bash', [join(f.root, 'scripts/configure-desktop-release.sh')], { env, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unexpected branch policies');
    expect(f.readState().calls.some((a: string[]) => a.includes('PUT'))).toBe(false);
    expect(f.readState().secrets).toBeUndefined();
    expect(f.readState().enabled).toBeUndefined();
  });
});
