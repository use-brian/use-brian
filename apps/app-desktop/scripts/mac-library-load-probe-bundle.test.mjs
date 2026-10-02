import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { bundleLibraryLoadProbe, manifest } from './mac-library-load-probe-bundle.mjs';
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'library-load-bundle-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'repo');
  for (const name of manifest) { mkdirSync(dirname(join(sourceRoot, name)), { recursive: true }); writeFileSync(join(sourceRoot, name), `source only: ${name}\n`); }
  return { root, sourceRoot, output: join(root, 'source.tar') };
}
function entries(tar) {
  const result = [];
  let at = 0;
  while (tar[at] !== 0) {
    const h = tar.subarray(at, at + 512), copy = Buffer.from(h); copy.fill(32, 148, 156);
    assert.equal(parseInt(h.subarray(148, 156).toString(), 8), copy.reduce((a, b) => a + b, 0));
    assert.equal(h[156], 48); // regular file only, no links/exec scripts/metadata extensions
    assert.equal(parseInt(h.subarray(100, 108).toString(), 8), 0o644);
    assert.equal(parseInt(h.subarray(136, 148).toString(), 8), 0);
    const name = h.subarray(0, 100).toString().split('\0')[0], size = parseInt(h.subarray(124, 136).toString(), 8);
    result.push([name, tar.subarray(at + 512, at + 512 + size)]);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  assert.deepEqual(tar.subarray(at), Buffer.alloc(1024));
  return result;
}
test('allowlisted source bytes only; deterministic metadata/manifest; no deps/logs/binaries/shims', t => {
  const f = fixture(t);
  for (const name of ['.env', 'inert', 'codesign', 'clang', 'compile.log', 'format-fixture.json', 'node_modules/private']) {
    const path = join(f.sourceRoot, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'PRIVATE');
  }
  const first = bundleLibraryLoadProbe(f), second = bundleLibraryLoadProbe({ ...f, output: join(f.root, 'second.tar') });
  assert.equal(first.sha256, second.sha256); assert.deepEqual(first.checksums, second.checksums);
  const tar = readFileSync(f.output); assert.deepEqual(tar, readFileSync(second.output));
  assert.equal(statSync(f.output).mode & 0o777, 0o600);
  assert.equal(manifest.length, 3);
  assert(manifest.every(name => !/test|bundle/.test(name)));
  assert.deepEqual(entries(tar).map(([name]) => name), [...manifest]);
  for (const [i, [name, data]] of entries(tar).entries()) {
    assert.deepEqual(data, readFileSync(join(f.sourceRoot, name)));
    assert.equal(first.checksums[i], `${createHash('sha256').update(data).digest('hex')}  ${name}`);
  }
});
test('real allowlist is self-contained source, not copied outputs', t => {
  const f = fixture(t); bundleLibraryLoadProbe({ output: f.output });
  const actual = entries(readFileSync(f.output));
  assert.equal(actual.length, manifest.length);
  const collector = actual.find(([name]) => name.endsWith('/mac-library-load-probe.mjs'))[1].toString();
  assert.match(collector, /--allow-ad-hoc-library-load-tests/);
  assert.match(collector, /parseRunnerOutput/);
  assert.ok(!collector.includes('extractAuthenticatedLibraryConstraint('));
  const extracted = join(f.root, 'extracted');
  for (const [name, data] of actual) {
    const path = join(extracted, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data);
  }
  const refusal = spawnSync(process.execPath, [join(extracted, manifest[0])], {
    cwd: extracted, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
  });
  assert.equal(refusal.status, 1, refusal.stderr);
  assert.equal(refusal.stderr, '');
  const report = JSON.parse(refusal.stdout);
  assert.equal(report.status, 'refused');
  assert.equal(report.productionAuthority, false);
  assert.equal(report.executionAttempted, false);
  for (const [name, data] of actual) assert.deepEqual(readFileSync(join(extracted, name)), data);
});
test('outside-repo absolute new .tar only; refuses overwrite', t => {
  const f = fixture(t);
  for (const output of [undefined, 'relative.tar', join(f.sourceRoot, 'bad.tar'), join(f.root, 'bad.zip')]) assert.throws(() => bundleLibraryLoadProbe({ ...f, output }));
  bundleLibraryLoadProbe(f); const before = readFileSync(f.output);
  assert.throws(() => bundleLibraryLoadProbe(f), /EEXIST/); assert.deepEqual(readFileSync(f.output), before);
});
test('missing, oversized, directory, symlink and hardlink sources reject', t => {
  const f = fixture(t), path = join(f.sourceRoot, manifest[0]);
  rmSync(path); assert.throws(() => bundleLibraryLoadProbe(f));
  mkdirSync(path); assert.throws(() => bundleLibraryLoadProbe(f), /regular source/); rmSync(path, { recursive: true });
  symlinkSync(join(f.sourceRoot, manifest[1]), path); assert.throws(() => bundleLibraryLoadProbe(f), /Symlinks/); rmSync(path);
  linkSync(join(f.sourceRoot, manifest[1]), path); assert.throws(() => bundleLibraryLoadProbe(f), /regular source/); rmSync(path);
  writeFileSync(path, Buffer.alloc(1024 * 1024 + 1)); assert.throws(() => bundleLibraryLoadProbe(f), /regular source/);
  for (const binary of [Buffer.from([0, 1, 2]), Buffer.from([0xff, 0xfe])]) {
    writeFileSync(path, binary); assert.throws(() => bundleLibraryLoadProbe(f), /source text/);
  }
});
test('source/output ancestor symlinks and target symlinks rejected without modifying target', t => {
  const f = fixture(t), alias = join(f.root, 'alias');
  symlinkSync(f.sourceRoot, alias); assert.throws(() => bundleLibraryLoadProbe({ ...f, sourceRoot: alias }), /Symlinks/);
  const parent = join(f.root, 'parent'); symlinkSync(f.root, parent);
  assert.throws(() => bundleLibraryLoadProbe({ ...f, output: join(parent, 'bad.tar') }), /Symlinks/);
  const target = join(f.root, 'target'); writeFileSync(target, 'untouched'); symlinkSync(target, f.output);
  assert.throws(() => bundleLibraryLoadProbe(f)); assert.equal(readFileSync(target, 'utf8'), 'untouched');
});
