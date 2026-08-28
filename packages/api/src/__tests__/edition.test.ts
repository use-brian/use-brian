import { describe, expect, it } from 'vitest'
import { usesOpenStandaloneRoutes } from '../edition.js'

describe('[COMP:api/deployment-edition] standalone route ownership', () => {
  it('includes OSS and Outpost but excludes hosted', () => {
    expect(usesOpenStandaloneRoutes('oss')).toBe(true)
    expect(usesOpenStandaloneRoutes('outpost')).toBe(true)
    expect(usesOpenStandaloneRoutes('hosted')).toBe(false)
  })
})
