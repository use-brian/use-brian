import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { bundle, manifest } from './mac-preflight-bundle.mjs'

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mac-source-bundle-test-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sourceRoot = join(root, 'repo'), sourceDir = join(sourceRoot, 'native')
  mkdirSync(sourceDir, { recursive: true })
  for (const name of manifest) writeFileSync(join(sourceDir, name), `source ${name}\n`)
  return { root, sourceRoot, sourceDir, output: join(root, 'bundle.tar') }
}
function entries(tar) {
  const result = []
  for (let offset = 0; tar[offset] !== 0; ) {
    const header = tar.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString().split('\0')[0]
    const size = parseInt(header.subarray(124, 136).toString(), 8)
    const stored = parseInt(header.subarray(148, 156).toString(), 8)
    const check = Buffer.from(header); check.fill(32, 148, 156)
    assert.equal(stored, check.reduce((sum, byte) => sum + byte, 0))
    assert.equal(header[156], '0'.charCodeAt(0))
    result.push([name, tar.subarray(offset + 512, offset + 512 + size)])
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return result
}

test('exact allowlist, deterministic tar/checksums, source bytes only, no execution', t => {
  const f = fixture(t)
  writeFileSync(join(f.sourceDir, '.env'), 'secret')
  mkdirSync(join(f.sourceDir, 'node_modules'))
  writeFileSync(join(f.sourceDir, 'build.sh'), 'exit 99\n')
  const first = bundle(f)
  const second = bundle({ ...f, output: join(f.root, 'second.tar') })
  assert.equal(first.sha256, second.sha256)
  assert.deepEqual(first.checksums, second.checksums)
  const tar = readFileSync(f.output)
  assert.deepEqual(tar, readFileSync(second.output))
  const actual = entries(tar)
  assert.deepEqual(actual.map(([name]) => name), [...manifest])
  assert.equal(actual.length, 19)
  for (const prerequisite of ['BootstrapApprovalAnchor.c', 'BootstrapApprovalAnchor.h', 'LibraryConstraintPolicy.swift', 'MachOLibraryConstraint.swift', 'BootstrapApproval.swift', 'BootstrapApprovalReader.swift', 'BootstrapProcessBinding.swift', 'ElectronFrameworkBinding.swift']) {
    assert.ok(manifest.includes(prerequisite), prerequisite)
  }
  for (const [i, [name, data]] of actual.entries()) {
    assert.deepEqual(data, readFileSync(join(f.sourceDir, name)))
    assert.equal(first.checksums[i], `${createHash('sha256').update(data).digest('hex')}  ${name}`)
  }
  assert.deepEqual(readdirSync(f.root).sort(), ['bundle.tar', 'repo', 'second.tar'])
})

test('real source bundle runs portable smoke without repository dependencies', t => {
  const f = fixture(t)
  bundle({ output: f.output })
  const extracted = join(f.root, 'extracted')
  mkdirSync(extracted)
  for (const [name, data] of entries(readFileSync(f.output))) writeFileSync(join(extracted, name), data)
  const result = spawnSync(process.execPath, [join(extracted, 'smoke.mjs'), '--portable'], {
    cwd: extracted, encoding: 'utf8', env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /PASS portable framing/)
})

test('explicit absolute outside-source new tar path required', t => {
  const f = fixture(t)
  for (const output of [undefined, 'relative.tar', join(f.sourceDir, 'bad.tar'), join(f.sourceRoot, 'bad.tar'), join(f.root, 'bad.zip')]) {
    assert.throws(() => bundle({ ...f, output }))
  }
  bundle(f)
  assert.throws(() => bundle(f), /EEXIST/)
})

test('rejects file and directory source symlinks and missing/irregular files', t => {
  const f = fixture(t), path = join(f.sourceDir, manifest[0])
  rmSync(path)
  assert.throws(() => bundle(f), /ENOENT/)
  mkdirSync(path)
  assert.throws(() => bundle(f), /regular source/)
  rmSync(path, { recursive: true })
  symlinkSync(join(f.sourceDir, manifest[1]), path)
  assert.throws(() => bundle(f), /Symlinks/)
  const alias = join(f.root, 'alias')
  symlinkSync(f.sourceDir, alias)
  assert.throws(() => bundle({ ...f, sourceDir: alias }), /Symlinks/)
})

test('rejects output symlink or symlinked output parent without touching target', t => {
  const f = fixture(t), target = join(f.root, 'untouched')
  writeFileSync(target, 'original')
  symlinkSync(target, f.output)
  assert.throws(() => bundle(f))
  assert.equal(readFileSync(target, 'utf8'), 'original')
  const parent = join(f.root, 'alias')
  symlinkSync(f.root, parent)
  assert.throws(() => bundle({ ...f, output: join(parent, 'new.tar') }), /Symlinks/)
})
