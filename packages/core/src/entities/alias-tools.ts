import { z } from 'zod'
import { buildTool, type ToolContext } from '../tools/types.js'
import { isAttendedTurn } from '../tools/capability-gate.js'
import { notFoundFailure, toolFailure } from '../tools/tool-failure.js'
import type { AccessContext } from '../security/access-context.js'
import type { EntityStore } from './types.js'

// Native alias curation is available without the optional Brain reclassifier.
// Spec: docs/architecture/features/crm.md, Native aliases.
function aliasAccess(context: ToolContext): AccessContext {
  return {
    workspaceId: context.workspaceId!, userId: context.userId,
    assistantId: context.assistantId, assistantKind: context.assistantKind ?? 'standard',
    clearance: context.clearance, compartments: context.compartments,
    projectIds: context.projectIds,
  }
}

function workspaceGate(
  workspaceId: string | null | undefined,
  tool: string,
): { data: string; isError: true } | null {
  if (!workspaceId) {
    return {
      data:
        `\`${tool}\` did not run: this chat is not bound to a workspace, and native aliases belong to records in one workspace. Nothing was changed. ` +
        'Ask the user to run this from a workspace chat (or from the web app) and carry on answering the rest of their message. ' +
        'No argument change will help in this session; do not retry.',
      isError: true,
    }
  }
  return null
}

export function createEntityAliasTools(entities: Pick<EntityStore, 'addAlias' | 'removeAlias'>) {
  // ── noteAlias ──────────────────────────────────────────────────

  const noteAlias = buildTool({
    name: 'noteAlias',
    description:
      'Register a native alias (alternate name or nickname) for an existing CRM contact, company, deal, or other Brain entity. CRM record ids are entity ids. Keep the canonical display name and existing fields unchanged; never append an alias to the name, create a replacement contact, or store it only in memory/custom fields. Confirm success only from the returned persisted aliases. After this, ' +
      'search and duplicate review can rank the entity for that alias. ' +
      'For people, an alias is never mutation identity and later extraction ' +
      'still creates a distinct person unless a stable provider binding or ' +
      'explicit target id supplies authority. ' +
      'Use when the user says "AC is the same as Acme Corp", "tonic ' +
      'is short for acme-labs/tonic", or "acme-labs/gateway ' +
      'is the gateway repo". Aliases are stored lowercase but ' +
      'case-insensitively matched. Returns a conflict error (with the ' +
      'other entity id) if the alias is already bound to a different ' +
      'visible live entity in this workspace. Ask the user to resolve an identity conflict; never merge records just to make an alias write succeed.',
    inputSchema: z.object({
      entity_id: z
        .string()
        .uuid()
        .describe('The canonical entity id that the alias should resolve to.'),
      alias: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe(
          'The alternate name to register. Lowercased + trimmed for storage; ' +
            'case-insensitive on lookup.',
        ),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,

    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId, 'noteAlias')
      if (gate) return gate
      try {
        const result = await entities.addAlias(
          context.userId,
          input.entity_id,
          input.alias,
          aliasAccess(context),
        )
        if (result.kind === 'not_found') {
          return notFoundFailure({
            kind: 'Entity',
            id: input.entity_id,
            discoveryTool: 'searchBrain / getEntity',
            extra: `The alias "${input.alias}" was NOT registered. The record may also be above this assistant's clearance, which reads the same as missing.`,
            idSource: 'a searchBrain / getEntity / listContacts result, never a display name',
          })
        }
        if (result.kind === 'conflict') {
          // D5: prose first, structured tail after: a multi-key object would
          // reach the model as raw JSON it has to parse to read a sentence.
          return {
            data:
              `noteAlias did not register "${input.alias}" on entity ${input.entity_id}: that alias is already bound to a DIFFERENT live entity, ${result.conflictingEntityId}, and one alias cannot resolve to two records. Nothing was changed. ` +
              `Ask the user whether these are the same entity before considering an explicit merge; otherwise choose a more specific alias. Do not rename, delete, or recreate either record to work around this conflict. ` +
              'Retrying this exact alias unchanged will keep failing. ' +
              `(conflicting_entity_id: ${result.conflictingEntityId})`,
            isError: true,
          }
        }
        return {
          data: {
            entityId: result.entity.id,
            displayName: result.entity.displayName,
            aliases: result.entity.aliases,
          },
        }
      } catch (err) {
        return toolFailure(err, {
          tool: 'noteAlias',
          target: `alias "${input.alias}" on entity ${input.entity_id}`,
          mutating: true,
          next: 'Entity ids come from searchBrain / getEntity and are superseded by a merge: re-resolve there if this one is stale.',
        })
      }
    },
  })

  // ── splitAlias ────────────────────────────────────────────────

  const splitAlias = buildTool({
    name: 'splitAlias',
    description:
      'Remove a previously-registered alias from an entity. Use when ' +
      'the user says "actually AC is NOT Acme Corp" or "stop treating ' +
      'X as Y". This removes only the search alias; it does not split, delete, or rename the record. Idempotent: ' +
      'removing an alias that was not registered is a no-op.',
    inputSchema: z.object({
      entity_id: z.string().uuid(),
      alias: z.string().trim().min(1).max(200),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    // Preserve the existing confirmation gate for autonomous alias removal.
    resolveConfirmation: async (context) => !isAttendedTurn(context),

    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId, 'splitAlias')
      if (gate) return gate
      try {
        const updated = await entities.removeAlias(
          context.userId,
          input.entity_id,
          input.alias,
          aliasAccess(context),
        )
        if (!updated) {
          return notFoundFailure({
            kind: 'Entity',
            id: input.entity_id,
            discoveryTool: 'searchBrain / getEntity',
            extra: `The alias "${input.alias}" was NOT removed. The record may also be above this assistant's clearance, which reads the same as missing. (Removing an alias the entity never had is a no-op, not this error: this error means the ENTITY did not resolve.)`,
            idSource: 'a searchBrain / getEntity / listContacts result, never a display name',
          })
        }
        return {
          data: {
            entityId: updated.id,
            displayName: updated.displayName,
            aliases: updated.aliases,
          },
        }
      } catch (err) {
        return toolFailure(err, {
          tool: 'splitAlias',
          target: `alias "${input.alias}" on entity ${input.entity_id}`,
          mutating: true,
          next: 'Entity ids come from searchBrain / getEntity and are superseded by a merge: re-resolve there if this one is stale.',
        })
      }
    },
  })

  return [noteAlias, splitAlias]
}
