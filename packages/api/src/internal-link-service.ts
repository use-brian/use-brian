/**
 * Authorized command service for private workspace/page links.
 * HTTP routes, UI calls, and Brian tools all use this boundary.
 *
 * [COMP:api/internal-links]
 */

import {
  buildAliasInternalLink,
  isValidInternalAlias,
} from '@use-brian/shared/desktop-links'
import type { SavedViewStore } from '@use-brian/core/views/types.js'
import type {
  AliasAvailability,
  InternalLinkAliases,
  InternalLinkAliasStore,
} from './db/internal-link-alias-store.js'
import type { WorkspaceAuditStore } from './db/workspace-audit-store.js'
import type { WorkspaceStore } from './db/workspace-store.js'

export type InternalLinkValue = InternalLinkAliases & Readonly<{
  sharePath: string
  url: string
  canonicalPath: string
}>

export type InternalLinkResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{
      ok: false
      reason: 'not_found' | 'forbidden' | 'invalid_alias' | 'conflict'
      suggestion?: string
    }>

export type InternalLinkService = {
  ensure(actorUserId: string, input: { workspaceId: string; pageId?: string }): Promise<InternalLinkResult<InternalLinkValue>>
  resolve(actorUserId: string, input: { workspaceAlias: string; pageAlias?: string }): Promise<InternalLinkResult<InternalLinkValue>>
  renameWorkspace(actorUserId: string, workspaceId: string, alias: string): Promise<InternalLinkResult<InternalLinkValue>>
  renamePage(actorUserId: string, pageId: string, alias: string): Promise<InternalLinkResult<InternalLinkValue>>
  workspaceAvailability(actorUserId: string, workspaceId: string, alias: string): Promise<InternalLinkResult<AliasAvailability>>
  pageAvailability(actorUserId: string, pageId: string, alias: string): Promise<InternalLinkResult<AliasAvailability>>
}

function valueFor(appOrigin: string, aliases: InternalLinkAliases): InternalLinkValue {
  const url = buildAliasInternalLink({
    appOrigin,
    workspaceAlias: aliases.workspaceAlias,
    pageAlias: aliases.pageAlias,
  })
  return {
    ...aliases,
    url,
    sharePath: new URL(url).pathname,
    canonicalPath: `/w/${encodeURIComponent(aliases.workspaceId)}/p${aliases.pageId ? `/${encodeURIComponent(aliases.pageId)}` : ''}`,
  }
}

export function createInternalLinkService(deps: {
  store: InternalLinkAliasStore
  workspaceStore: WorkspaceStore
  savedViewStore: SavedViewStore
  auditStore: WorkspaceAuditStore
  appOrigin: string
  onAliasChanged?: (event: {
    workspaceId: string
    pageId?: string
    workspaceAlias: string
    pageAlias?: string
  }) => void | Promise<void>
}): InternalLinkService {
  const appOrigin = new URL(deps.appOrigin).origin

  async function authorizedPage(actorUserId: string, pageId: string) {
    const page = await deps.savedViewStore.getById(actorUserId, pageId)
    if (!page) return null
    const role = await deps.workspaceStore.getRole(actorUserId, page.workspaceId)
    return role ? { page, role } : null
  }

  async function notify(aliases: InternalLinkAliases): Promise<void> {
    await deps.onAliasChanged?.({
      workspaceId: aliases.workspaceId,
      pageId: aliases.pageId,
      workspaceAlias: aliases.workspaceAlias,
      pageAlias: aliases.pageAlias,
    })
  }

  return {
    async ensure(actorUserId, input) {
      const workspace = await deps.workspaceStore.get(actorUserId, input.workspaceId)
      if (!workspace) return { ok: false, reason: 'not_found' }

      let pageTitle: string | undefined
      if (input.pageId) {
        const page = await deps.savedViewStore.getById(actorUserId, input.pageId)
        if (!page || page.workspaceId !== input.workspaceId) {
          return { ok: false, reason: 'not_found' }
        }
        pageTitle = page.name
      }

      const aliases = await deps.store.ensure({
        workspaceId: input.workspaceId,
        workspaceName: workspace.name,
        pageId: input.pageId,
        pageTitle,
        actorUserId,
      })
      return aliases
        ? { ok: true, value: valueFor(appOrigin, aliases) }
        : { ok: false, reason: 'not_found' }
    },

    async resolve(actorUserId, input) {
      if (
        !isValidInternalAlias(input.workspaceAlias, 'workspace') ||
        (input.pageAlias && !isValidInternalAlias(input.pageAlias, 'page'))
      ) {
        return { ok: false, reason: 'not_found' }
      }
      const aliases = await deps.store.resolve(input.workspaceAlias, input.pageAlias)
      if (!aliases) return { ok: false, reason: 'not_found' }

      const role = await deps.workspaceStore.getRole(actorUserId, aliases.workspaceId)
      if (!role) return { ok: false, reason: 'not_found' }
      if (aliases.pageId) {
        const page = await deps.savedViewStore.getById(actorUserId, aliases.pageId)
        if (!page || page.workspaceId !== aliases.workspaceId) {
          return { ok: false, reason: 'not_found' }
        }
      }
      return { ok: true, value: valueFor(appOrigin, aliases) }
    },

    async renameWorkspace(actorUserId, workspaceId, alias) {
      if (!isValidInternalAlias(alias, 'workspace')) {
        return { ok: false, reason: 'invalid_alias' }
      }
      const workspace = await deps.workspaceStore.get(actorUserId, workspaceId)
      const role = await deps.workspaceStore.getRole(actorUserId, workspaceId)
      if (!workspace) return { ok: false, reason: 'not_found' }
      if (role !== 'owner' && role !== 'admin') return { ok: false, reason: 'forbidden' }

      const renamed = await deps.store.renameWorkspace({
        workspaceId,
        alias,
        workspaceName: workspace.name,
        actorUserId,
      })
      if (!renamed.ok) return renamed
      void deps.auditStore.append({
        workspaceId,
        actorUserId,
        eventType: 'workspace.link_alias_changed',
        details: { alias },
      })
      await notify(renamed.aliases)
      return { ok: true, value: valueFor(appOrigin, renamed.aliases) }
    },

    async renamePage(actorUserId, pageId, alias) {
      if (!isValidInternalAlias(alias, 'page')) {
        return { ok: false, reason: 'invalid_alias' }
      }
      const authorized = await authorizedPage(actorUserId, pageId)
      if (!authorized) return { ok: false, reason: 'not_found' }
      if (
        authorized.page.createdBy !== actorUserId &&
        authorized.role !== 'owner' &&
        authorized.role !== 'admin'
      ) {
        return { ok: false, reason: 'forbidden' }
      }

      const renamed = await deps.store.renamePage({
        workspaceId: authorized.page.workspaceId,
        pageId,
        alias,
        pageTitle: authorized.page.name,
        actorUserId,
      })
      if (!renamed.ok) return renamed
      void deps.auditStore.append({
        workspaceId: authorized.page.workspaceId,
        actorUserId,
        eventType: 'page.link_alias_changed',
        subjectId: pageId,
        details: { alias },
      })
      await notify(renamed.aliases)
      return { ok: true, value: valueFor(appOrigin, renamed.aliases) }
    },

    async workspaceAvailability(actorUserId, workspaceId, alias) {
      if (!isValidInternalAlias(alias, 'workspace')) {
        return { ok: false, reason: 'invalid_alias' }
      }
      const workspace = await deps.workspaceStore.get(actorUserId, workspaceId)
      const role = await deps.workspaceStore.getRole(actorUserId, workspaceId)
      if (!workspace) return { ok: false, reason: 'not_found' }
      if (role !== 'owner' && role !== 'admin') return { ok: false, reason: 'forbidden' }
      return {
        ok: true,
        value: await deps.store.workspaceAvailability(workspaceId, alias, workspace.name),
      }
    },

    async pageAvailability(actorUserId, pageId, alias) {
      if (!isValidInternalAlias(alias, 'page')) {
        return { ok: false, reason: 'invalid_alias' }
      }
      const authorized = await authorizedPage(actorUserId, pageId)
      if (!authorized) return { ok: false, reason: 'not_found' }
      if (
        authorized.page.createdBy !== actorUserId &&
        authorized.role !== 'owner' &&
        authorized.role !== 'admin'
      ) {
        return { ok: false, reason: 'forbidden' }
      }
      return {
        ok: true,
        value: await deps.store.pageAvailability(
          authorized.page.workspaceId,
          pageId,
          alias,
          authorized.page.name,
        ),
      }
    },
  }
}
