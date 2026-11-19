import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_MODULE_KEYS,
  WORKSPACE_MODULES,
  WORKSPACE_MODULE_STATES,
  defineWorkspaceModuleRegistry,
  isWorkspaceModuleKey,
  workspaceModuleAdmits,
  workspaceModuleKeys,
} from '../workspace-modules.js'

describe('[COMP:shared/workspace-modules] Module admission contract', () => {
  it('starts new workspaces disabled and admits new commerce only while enabled', () => {
    expect(WORKSPACE_MODULE_KEYS).toEqual([])
    expect(isWorkspaceModuleKey('association')).toBe(false)
    expect(isWorkspaceModuleKey('tenant-specific-module')).toBe(false)
    for (const state of WORKSPACE_MODULE_STATES) {
      expect(workspaceModuleAdmits(state, 'new_commerce')).toBe(state === 'enabled')
      expect(workspaceModuleAdmits(state, 'new_work')).toBe(state === 'enabled')
      expect(workspaceModuleAdmits(state, 'read')).toBe(true)
      expect(workspaceModuleAdmits(state, 'existing_recovery')).toBe(true)
    }
  })

  it('accepts a caller-supplied registry without changing the default registry', () => {
    const registry = defineWorkspaceModuleRegistry({ test_module: {
      key: 'test_module', defaultState: 'enabled',
    } } as const)
    expect(workspaceModuleKeys(registry)).toEqual(['test_module'])
    expect(isWorkspaceModuleKey('test_module', registry)).toBe(true)
    expect(isWorkspaceModuleKey('association', registry)).toBe(false)
    expect(WORKSPACE_MODULE_KEYS).toEqual([])
  })
})
