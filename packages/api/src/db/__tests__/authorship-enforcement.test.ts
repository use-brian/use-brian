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
import type { Sensitivity } from '@sidanclaw/core'

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

// ── Q24: CRM-specialized kinds blocked from direct createEntity ───────
//
// `createEntity` rejects `kind='person'|'company'|'deal'` (Q24) — those
// kinds are CRM specializations and must be created through the
// `saveContact` / `saveCompany` / `saveDeal` wrappers, which write the
// `entities` row and its specialization row (`contacts` / `companies` /
// `deals`) in one transaction. A direct insert here would brain-orphan
// the entity. The guard fires after the authorship check and before any
// SQL, so a valid `createdByUserId` reaches it without a DB connection.
//
// Spec: docs/plans/company-brain/data-model.md §"CRM as specialization
// of entities"; decisions-log.md Q24.

describe('[COMP:brain/crm-write-wrapper] createEntity Q24 direct-insert block', () => {
  const base = {
    displayName: 'Acme',
    workspaceId: 'w-1',
    createdByUserId: 'u-1',
    source: 'user' as const,
  }

  for (const kind of ['person', 'company', 'deal'] as const) {
    it(`rejects a direct createEntity for kind='${kind}'`, async () => {
      await expect(createEntity({ ...base, kind })).rejects.toThrow(
        /reserved for the CRM specialization/,
      )
    })
  }

  it('the rejection names the kind and directs to the CRM wrappers', async () => {
    let thrown: unknown
    try {
      await createEntity({ ...base, kind: 'company' })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    const msg = (thrown as Error).message
    expect(msg).toContain("kind='company'")
    expect(msg).toContain('reserved for the CRM specialization')
    expect(msg).toContain('saveCompany')
  })
})
