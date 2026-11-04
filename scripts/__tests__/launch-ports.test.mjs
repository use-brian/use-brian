import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveApiPort, resolveRigApiPort } from '../launch-ports.mjs'

describe('[COMP:platform/local-rig] Alternate API port', () => {
  it('defaults to 4000 and accepts an alternate unprivileged port', () => {
    assert.equal(resolveApiPort(), 4000)
    assert.equal(resolveApiPort('4100'), 4100)
  })
  it('rejects invalid, privileged and reserved stack ports', () => {
    for (const value of ['', 'abc', '4100x', '4100.5', '1e4', '0', '-1', '80', '65536', '3003', '8080', '8094', '54329']) {
      assert.throws(() => resolveApiPort(value))
    }
  })
  it('reuses saved state, allows a requested override, but tears down the recorded port', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-port-test-'))
    const path = join(dir, 'api-port')
    try {
      assert.equal(resolveRigApiPort(path, {}), 4000)
      assert.equal(resolveRigApiPort(path, { USEBRIAN_API_PORT: '4200' }, true), 4000)
      writeFileSync(path, '4100\n')
      assert.equal(resolveRigApiPort(path, {}), 4100)
      assert.equal(resolveRigApiPort(path, { USEBRIAN_API_PORT: '4200' }), 4200)
      assert.equal(resolveRigApiPort(path, { USEBRIAN_API_PORT: '4200' }, true), 4100)
      writeFileSync(path, 'broken')
      assert.throws(() => resolveRigApiPort(path, { USEBRIAN_API_PORT: '4200' }))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('wires the selected port through boot, URL generation, readiness and teardown', () => {
    const source = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
    const launch = source('launch.mjs')
    for (const name of ['API_INTERNAL_URL', 'API_URL', 'NEXT_PUBLIC_API_URL']) {
      assert.match(launch, new RegExp(`${name}: .+PORTS\\.api`))
    }
    assert.match(launch, /api: resolveApiPort\(process.env.USEBRIAN_API_PORT\)/)
    assert.match(launch, /PORT: String\(PORTS.api\)/)
    // Runtime browser config must use the same-origin proxy, not the visiting
    // machine's localhost. An explicit public deployment URL still wins.
    assert.match(launch, /PUBLIC_API_URL: process\.env\.PUBLIC_API_URL \?\? ''/)
    const up = source('rig-up.sh')
    assert.match(up, /USEBRIAN_API_PORT="\$API_PORT"/)
    assert.match(up, /http:\/\/127.0.0.1:\$API_PORT\/auth\/local-session/)
    assert.match(up, /\[ "\$API_PORT" = "\$recorded_api_port" \] \|\| die/)
    assert.match(source('rig-down.sh'), /RIG_PORTS=\("\$API_PORT" 3003 8080/)
  })
})
