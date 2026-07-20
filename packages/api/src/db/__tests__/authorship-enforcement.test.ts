/**
 * Authorship NOT NULL enforcement at the store insert layer
 * (company-brain WU-4.5). Component tag: [COMP:brain/authorship-enforcement].
 *
 * Pure unit tests. No DB connection — every guard fires at the top of
 * its insert helper, before any `query` / `queryWithRLS` / `getPool`
 * call, so a `''` (empty) `createdByUserId` raises `TypeError` without
 * touching the DB.
 *
 * Spec: docs/plans/company-brain/permissions.md → "Authorship and audit".
 * Schema note: docs/plans/company-brain/migration 128 header — the DB
 * column stays nullable; enforcement is purely at the application
 * boundary so legacy rows remain valid.
 */

import { describe, expect, it } from 'vitest'
import type { Sensitivity } from '@use-brian/core'

import { assertAuthorshipPresent } from '../authorship-guard.js'
import { createCompany, createContact, createDeal } from '../crm.js'
import { createEntity } from '../entities-store.js'
import { createEpisode } from '../episodes-store.js'
import { createMemory } from '../memories.js'
import { createTask } from '../tasks.js'
import { createWorkspaceFile } from '../workspace-files.js'

describe('[COMP:brain/authorship-enforcement] assertAuthorshipPresent', () => {
  it('rejects undefined', () => {
    expect(() => assertAuthorshipPresent('h', undefined)).toThrowError(TypeError)
  })

  it('rejects null', () => {
    expect(() => assertAuthorshipPresent('h', null)).toThrowError(TypeError)
  })

  it('rejects empty string', () => {
    expect(() => assertAuthorshipPresent('h', '')).toThrowError(TypeError)
  })

  it('rejects whitespace-only string', () => {
    expect(() => assertAuthorshipPresent('h', '   ')).toThrowError(TypeError)
  })

  it('error message names the helper and references WU-4.5', () => {
    let thrown: unknown
    try {
      assertAuthorshipPresent('createXyz', '')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(TypeError)
    const msg = (thrown as Error).message
    expect(msg).toContain('createXyz')
    expect(msg).toContain('createdByUserId')
    expect(msg).toContain('WU-4.5')
  })

  it('accepts a non-empty string and returns void', () => {
    expect(() => assertAuthorshipPresent('h', 'u-1')).not.toThrow()
  })
})

// ── Insert helper wiring ─────────────────────────────────────────────
//
// Each helper assertion fires before any SQL. We invoke the helper
// with a deliberately empty `createdByUserId` (or, for helpers where
// authorship is sourced from a positional `userId` arg, an empty
// `userId`) and expect a `TypeError` that names the helper and
// references WU-4.5. No DB connection is required because the guard
// short-circuits.

function expectGuardThrow(p: Promise<unknown>, helper: string): Promise<void> {
  return expect(p).rejects.toThrowError(
    new RegExp(`${helper}.*createdByUserId.*WU-4\\.5`),
  )
}

describe('[COMP:brain/authorship-enforcement] insert helpers reject missing authorship', () => {
  it('createMemory rejects empty createdByUserId', async () => {
    await expectGuardThrow(
      createMemory({
        assistantId: 'a-1',
        userId: 'u-1',
        summary: 's',
        sensitivity: 'internal' as Sensitivity,
        createdByUserId: '',
      }),
      'createMemory',
    )
  })

  it('createTask rejects empty userId (the authorship source)', async () => {
    await expectGuardThrow(
      createTask('', {
        workspaceId: 'w-1',
        title: 't',
      }),
      'createTask',
    )
  })

  it('createWorkspaceFile rejects empty createdByUserId', async () => {
    await expectGuardThrow(
      createWorkspaceFile('u-1', {
        workspaceId: 'w-1',
        path: '/x',
        parentPath: '/',
        name: 'x',
        mime: 'text/plain',
        sizeBytes: 0,
        storageUri: 'gs://x',
        createdByUserId: '',
      }),
      'createWorkspaceFile',
    )
  })

  it('createCompany rejects empty userId (the authorship source)', async () => {
    await expectGuardThrow(
      createCompany('', { workspaceId: 'w-1', name: 'Acme' }),
      'createCompany',
    )
  })

  it('createContact rejects empty userId (the authorship source)', async () => {
    await expectGuardThrow(
      createContact('', { workspaceId: 'w-1', name: 'Alice' }),
      'createContact',
    )
  })

  it('createDeal rejects empty userId (the authorship source)', async () => {
    await expectGuardThrow(
      createDeal('', { workspaceId: 'w-1' }),
      'createDeal',
    )
  })

  it('createEntity rejects empty createdByUserId', async () => {
    await expectGuardThrow(
      createEntity({
        kind: 'person',
        displayName: 'Alice',
        workspaceId: 'w-1',
        createdByUserId: '',
        source: 'user',
      }),
      'createEntity',
    )
  })

  it('createEpisode rejects empty createdByUserId', async () => {
    await expectGuardThrow(
      createEpisode('u-1', {
        sourceKind: 'manual',
        sourceRef: {},
        occurredAt: new Date(),
        workspaceId: 'w-1',
        userId: 'u-1',
        assistantId: null,
        createdByUserId: '',
      }),
      'createEpisode',
    )
  })
})

// (Removed) "createEntity Q24 direct-insert block" tests. Post CRM→entity
// unification (docs/architecture/features/crm.md) `createEntity` no
// longer rejects kind='person'|'company'|'deal' — a person/company/deal IS
// a plain entity with typed fields in `attributes`. The CRM tools in
// crm.ts create these entities directly; their behaviour is covered by
// crm-store.integration.test.ts.
