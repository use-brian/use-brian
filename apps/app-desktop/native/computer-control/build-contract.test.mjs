// Portable BUILD ORCHESTRATION mocks only; no native compiler/signing acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t, failCompile = false) {
  const root = mkdtempSync(join(tmpdir(), 'native-build-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), bin = join(root, 'bin'), temporary = join(root, 'temporary');
  for (const p of [source, bin, temporary]) mkdirSync(p, { mode: 0o700 });
  copyFileSync(new URL('./build.sh', import.meta.url), join(source, 'build.sh'));
  writeFileSync(join(source, 'Helper.swift'), '// dispatcher sentinel: not executed\n');
  writeFileSync(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo arm64;; *) exit 90;; esac\n', { mode: 0o700 });
  writeFileSync(join(bin, 'xcrun'), `#!${process.execPath}\n` + `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const main = args.find(a => a.endsWith('/main.swift'));
    const row = { args, mainSource: main ? fs.readFileSync(main, 'utf8') : null,
      temporaryMode: main ? fs.statSync(require('node:path').dirname(main)).mode & 511 : null };
    fs.appendFileSync(process.env.BUILD_CONTRACT_LOG, JSON.stringify(row) + '\\n');
    if (process.env.BUILD_CONTRACT_FAIL === '1' && args.includes('BootstrapApprovalAnchor.c')) process.exit(42);
    const out = args.indexOf('-o');
    if (out < 0) process.exit(91);
    fs.writeFileSync(args[out + 1], 'mock compiler output, NEVER EXECUTED');
  `, { mode: 0o700 });
  writeFileSync(join(bin, 'codesign'), '#!/bin/sh\nexit 92\n', { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temporary,
    BUILD_CONTRACT_LOG: join(root, 'calls.jsonl'), BUILD_CONTRACT_FAIL: failCompile ? '1' : '0' };
  delete env.CODESIGN_IDENTITY; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const result = spawnSync('bash', [join(source, 'build.sh'), join(root, 'out')], { env, encoding: 'utf8' });
  const calls = readFileSync(env.BUILD_CONTRACT_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  return { result, calls, temporary, source };
}

test('build compiles linked bootstrap sources with a private main.swift copy; unsigned only', t => {
  const f = fixture(t);
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.match(f.result.stderr, /UNSIGNED development artifacts/);
  assert.equal(f.calls.length, 4);
  assert(f.calls[0].args.includes('ProcessIdentity.c'));
  assert(f.calls[1].args.includes('BootstrapApprovalAnchor.c'));
  const helper = f.calls[2];
  for (const file of ['LibraryConstraintPolicy.swift', 'MachOLibraryConstraint.swift', 'BootstrapApproval.swift', 'BootstrapApprovalReader.swift', 'BootstrapProcessBinding.swift', 'ElectronFrameworkBinding.swift']) assert(helper.args.includes(file), file);
  assert(helper.args.some(a => a.endsWith('/BootstrapApprovalAnchor.o')));
  assert.equal(helper.mainSource, readFileSync(join(f.source, 'Helper.swift'), 'utf8'));
  assert.equal(helper.temporaryMode, 0o700);
  assert(f.calls[3].args.includes('Fixture.swift'));
  assert.deepEqual(readdirSync(f.temporary), []);
});

test('anchor compiler failure stops before Swift/signing and removes private temporary source', t => {
  const f = fixture(t, true);
  assert.equal(f.result.status, 42);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(readdirSync(f.temporary), []);
  assert.equal(readFileSync(join(f.source, 'Helper.swift'), 'utf8'), '// dispatcher sentinel: not executed\n');
});

test('mapped reader has only an own-symbol source and no admission/parent/environment override', () => {
  const reader = readFileSync(new URL('./BootstrapApprovalReader.swift', import.meta.url), 'utf8');
  assert.match(reader, /brian_bootstrap_approval_copy\(buffer.baseAddress, buffer.count, &written\)/);
  assert.match(reader, /written == bytes.count/);
  assert.match(reader, /decode\(record: bytes\)/);
  assert.doesNotMatch(reader, /ProcessInfo|FileHandle|URL\(|getenv|CommandLine|JSONSerialization/);
  const helper = readFileSync(new URL('./Helper.swift', import.meta.url), 'utf8');
  assert.doesNotMatch(helper, /Broker\s*\(/);
  assert.match(helper, /probeOnlyResponse\(request, clock: sourceClock\)/);
});
