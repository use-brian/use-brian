import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-build-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function command(file, args, cwd, env = process.env) {
  return spawnSync(file, args, { cwd, env, encoding: 'utf8' });
}
function passes(result) {
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
}

test('composite package caches live with the dist outputs cached by Turbo', () => {
  for (const name of readdirSync(join(root, 'packages'))) {
    const path = join(root, 'packages', name, 'tsconfig.json');
    if (!existsSync(path)) continue;
    const config = json(path);
    if (config.compilerOptions?.composite) {
      assert.equal(config.compilerOptions.tsBuildInfoFile, 'dist/tsconfig.tsbuildinfo', name);
    }
  }
  const core = json(join(root, 'packages/core/package.json'));
  assert.equal(core.dependencies['@use-brian/computer-control'], 'workspace:*');
  assert.ok(json(join(root, 'turbo.json')).tasks.build.outputs.includes('dist/**'));
});

test('real computer-control build migrates stale cache and regenerates exports after dist removal', t => {
  const dir = temporary(t);
  const pkg = join(dir, 'packages/computer-control');
  mkdirSync(pkg, { recursive: true });
  cpSync(join(root, 'tsconfig.base.json'), join(dir, 'tsconfig.base.json'));
  for (const name of ['src', 'package.json']) cpSync(join(root, 'packages/computer-control', name), join(pkg, name), { recursive: true });
  symlinkSync(join(root, 'packages/computer-control/node_modules'), join(pkg, 'node_modules'), 'dir');
  const current = json(join(root, 'packages/computer-control/tsconfig.json'));
  const old = structuredClone(current);
  delete old.compilerOptions.tsBuildInfoFile;
  const config = join(pkg, 'tsconfig.json');
  writeFileSync(config, JSON.stringify(old));
  const tsc = join(root, 'node_modules/typescript/bin/tsc');
  const compile = (...args) => command(process.execPath, [tsc, ...args], pkg);
  passes(compile());
  assert.ok(existsSync(join(pkg, 'tsconfig.tsbuildinfo')));
  rmSync(join(pkg, 'dist'), { recursive: true });
  // The original bug: tsc succeeds while the public export is absent.
  passes(compile());
  assert.equal(existsSync(join(pkg, 'dist/protocol.d.ts')), false);
  writeFileSync(config, JSON.stringify(current));
  passes(compile());
  rmSync(join(pkg, 'dist'), { recursive: true });
  passes(compile('--noEmit'));
  passes(compile());
  for (const file of ['protocol.js', 'protocol.d.ts', 'tsconfig.tsbuildinfo']) assert.ok(existsSync(join(pkg, 'dist', file)), file);
  const consumer = join(dir, 'consumer');
  mkdirSync(join(consumer, 'node_modules/@use-brian'), { recursive: true });
  symlinkSync(pkg, join(consumer, 'node_modules/@use-brian/computer-control'), 'dir');
  writeFileSync(join(consumer, 'index.ts'), `import { NATIVE_PROTOCOL, BoundsSchema } from '@use-brian/computer-control/protocol.js';
const protocol: 'native-computer-v1' = NATIVE_PROTOCOL;
const width: number = BoundsSchema.parse({}).width;
`);
  passes(command(process.execPath, [tsc, '--strict', '--skipLibCheck', '--noEmit', '--module', 'ESNext', '--moduleResolution', 'bundler', '--target', 'ES2022', 'index.ts'], consumer));
});

function packagingFixture(t) {
  const dir = temporary(t);
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'apps/app-desktop/release'), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  for (const name of ['package-desktop.mjs', 'desktop-package-output.mjs']) cpSync(join(root, 'scripts', name), join(dir, 'scripts', name));
  writeFileSync(join(dir, 'apps/app-desktop/release/usebrian.zip'), 'old user package');
  writeFileSync(join(dir, 'bin/pnpm'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv.includes(process.env.FAIL_STAGE)) process.exit(7);
const output = process.argv.find(x => x.startsWith('--config.directories.output='))?.split('=')[1];
if (output && !process.env.MISSING_OUTPUT) for (const name of ['usebrian.zip', 'usebrian.dmg']) fs.writeFileSync(output + '/' + name, 'new package');
`, { mode: 0o755 });
  const env = { ...process.env, GITHUB_ACTIONS: 'false', PATH: `${join(dir, 'bin')}:${process.env.PATH}`, CALLS: join(dir, 'calls') };
  return { dir, env, run: extra => command(process.execPath, ['scripts/package-desktop.mjs', 'mac'], dir, { ...env, ...extra }) };
}

test('package failures never proceed to builder or advertise an old ZIP', t => {
  const { dir, env, run } = packagingFixture(t);
  const result = run({ FAIL_STAGE: 'build:renderer' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PACKAGE FAILED/);
  assert.doesNotMatch(result.stdout, /Package succeeded/);
  assert.equal(readFileSync(env.CALLS, 'utf8').trim(), '["run","build:renderer"]');
  assert.equal(readFileSync(join(dir, 'apps/app-desktop/release/usebrian.zip'), 'utf8'), 'old user package');
});

test('successful packages use unique directories; missing new ZIP is a failure', t => {
  const { dir, env, run } = packagingFixture(t);
  passes(run({}));
  passes(run({}));
  const result = run({ MISSING_OUTPUT: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing output: usebrian.zip/);
  assert.doesNotMatch(result.stdout, /Package succeeded/);
  const builders = readFileSync(env.CALLS, 'utf8').trim().split('\n').map(JSON.parse).filter(args => args.includes('electron-builder'));
  assert.equal(new Set(builders.map(args => args.find(arg => arg.startsWith('--config.directories.output=')))).size, 3);
  assert.ok(builders.every(args => args.includes('never')));
  assert.equal(readFileSync(join(dir, 'apps/app-desktop/release/usebrian.zip'), 'utf8'), 'old user package');
});

test('signed packaging refuses implicit artifact reuse without signing', t => {
  const { dir, env } = packagingFixture(t);
  cpSync(join(root, 'scripts/package-desktop.sh'), join(dir, 'scripts/package-desktop.sh'));
  writeFileSync(join(dir, 'bin/uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
  const result = command('bash', ['scripts/package-desktop.sh', '--no-build'], dir, env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--no-build requires --artifacts-dir/);
  assert.match(result.stderr, /PACKAGE FAILED/);
  assert.equal(existsSync(env.CALLS), false);
  assert.equal(readFileSync(join(dir, 'apps/app-desktop/release/usebrian.zip'), 'utf8'), 'old user package');
});

test('GitHub Actions preserves release paths but refuses any existing output directory', async t => {
  const { allocateOutput } = await import('../desktop-package-output.mjs');
  const dir = temporary(t);
  assert.equal(allocateOutput(dir, true), join(dir, 'release'));
  writeFileSync(join(dir, 'release/usebrian.zip'), 'existing package');
  assert.throws(() => allocateOutput(dir, true), /EEXIST/);
  assert.equal(readFileSync(join(dir, 'release/usebrian.zip'), 'utf8'), 'existing package');
});

test('signed packaging stops on build failure and only reports fresh artifacts on success (mock tools)', t => {
  const { dir, env } = packagingFixture(t);
  cpSync(join(root, 'scripts/package-desktop.sh'), join(dir, 'scripts/package-desktop.sh'));
  writeFileSync(join(dir, 'scripts/desktop-keychain.sh'), 'desktop_keychain_prepare() { :; }\ndesktop_keychain_cleanup() { :; }\n');
  for (const tool of ['codesign', 'xcrun', 'spctl']) writeFileSync(join(dir, 'bin', tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(dir, 'bin/uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
  const synthetic = { ...env, CSC_LINK: 'fixture', CSC_KEY_PASSWORD: 'fixture', APPLE_ID: 'fixture', APPLE_APP_SPECIFIC_PASSWORD: 'fixture', APPLE_TEAM_ID: 'fixture' };
  const failed = command('bash', ['scripts/package-desktop.sh'], dir, { ...synthetic, FAIL_STAGE: 'build:renderer' });
  assert.equal(failed.status, 7);
  assert.match(failed.stderr, /PACKAGE FAILED/);
  assert.doesNotMatch(failed.stdout, /Done\. Artifacts/);
  assert.equal(readFileSync(env.CALLS, 'utf8').trim(), '["--filter","@use-brian/app-desktop","run","build:renderer"]');
  const success = command('bash', ['scripts/package-desktop.sh'], dir, synthetic);
  passes(success);
  assert.match(success.stdout, /Done\. Artifacts in .*release\/runs\/mac-/);
  assert.equal(readFileSync(join(dir, 'apps/app-desktop/release/usebrian.zip'), 'utf8'), 'old user package');
});
