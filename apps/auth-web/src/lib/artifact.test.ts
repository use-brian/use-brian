import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('[COMP:app/outpost-auth] standalone artifact contract', () => {
  it('ships the standalone server and static assets in the runtime image', () => {
    const dockerfile = readFileSync(resolve(import.meta.dirname, '../../Dockerfile'), 'utf8')
    expect(dockerfile).toContain('/apps/auth-web/.next/standalone/')
    expect(dockerfile).toContain('/apps/auth-web/.next/static/')
    expect(dockerfile).toContain('node", "apps/auth-web/server.js')
    expect(dockerfile).toContain('/health')
  })
})
