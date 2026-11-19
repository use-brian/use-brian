import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../', import.meta.url))
const api = join(root, 'packages/api')
const isTest = path => /(?:^|[\\/])__tests__(?:[\\/]|$)|\.(?:test|spec)\./.test(path)

function config(path) {
  const result = ts.getParsedCommandLineOfConfigFile(path, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => assert.fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
  })
  assert.ok(result)
  assert.deepEqual(result.errors, [])
  return result
}

const build = config(join(api, 'tsconfig.json'))
const typecheck = config(join(api, 'tsconfig.typecheck.json'))

describe('API production build and test typecheck configs', () => {
  it('excludes only test roots from production while retaining them in typecheck', () => {
    const tests = typecheck.fileNames.filter(isTest)
    assert.ok(tests.length > 0)
    assert.ok(tests.some(path => path.includes('__tests__')))
    assert.ok(tests.some(path => path.endsWith('.integration.test.ts')))
    assert.deepEqual(build.fileNames, typecheck.fileNames.filter(path => !isTest(path)))
    // Project references are not inherited through extends.
    assert.ok(build.projectReferences.length > 0)
    assert.deepEqual(typecheck.projectReferences, build.projectReferences)
    assert.equal(typecheck.options.noEmit, true)
    assert.notEqual(build.options.noEmit, true)
    const pkg = JSON.parse(readFileSync(join(api, 'package.json'), 'utf8'))
    assert.equal(pkg.scripts.build, 'tsc')
    assert.equal(pkg.scripts.typecheck, 'tsc -p tsconfig.typecheck.json')
    assert.equal(pkg.scripts.test, 'vitest run')
    assert.equal(pkg.scripts['test:integration'], 'vitest run --config vitest.integration.config.ts')
  })

  it('does not pull excluded tests back into the production import graph', () => {
    const program = ts.createProgram({
      rootNames: build.fileNames,
      options: build.options,
      projectReferences: build.projectReferences,
    })
    const importedTests = program.getSourceFiles()
      .filter(file => !file.isDeclarationFile && isTest(relative(root, file.fileName)))
      .map(file => relative(root, file.fileName))
    assert.deepEqual(importedTests, [])
  })

  it('covers nested test helpers and test/spec TS/TSX files without excluding production fixtures', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'brian-api-build-config-'))
    try {
      const sources = [
        'src/index.ts', 'src/evals/fixture.ts',
        'src/__tests__/helper.ts', 'src/nested/__tests__/helper.ts',
        'src/example.test.ts', 'src/nested/example.spec.ts',
        'src/component.test.tsx', 'src/nested/component.spec.tsx',
      ]
      for (const path of sources) {
        mkdirSync(dirname(join(fixture, path)), { recursive: true })
        writeFileSync(join(fixture, path), 'export const fixture = true\n')
      }
      writeFileSync(join(fixture, 'tsconfig.json'), JSON.stringify({
        ...build.raw, extends: join(root, 'tsconfig.base.json'), references: [],
      }))
      writeFileSync(join(fixture, 'tsconfig.typecheck.json'), JSON.stringify({
        ...typecheck.raw, references: [],
      }))
      const productionFixture = config(join(fixture, 'tsconfig.json'))
      const testFixture = config(join(fixture, 'tsconfig.typecheck.json'))
      assert.deepEqual(productionFixture.fileNames.map(path => relative(fixture, path)).sort(),
        sources.filter(path => !isTest(path)).sort())
      assert.equal(testFixture.fileNames.length, sources.length)
      const writes = []
      ts.createProgram(testFixture.fileNames, testFixture.options)
        .emit(path => writes.push(path))
      assert.deepEqual(writes, [], 'typechecking must not emit JS or declarations')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
