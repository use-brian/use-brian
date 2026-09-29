import type { CreateExecutionContextInput } from '../execution-context.js'

declare const complete: CreateExecutionContextInput
void complete

// Production construction cannot omit identity or ownership.
// @ts-expect-error identity is required
const missingIdentity: CreateExecutionContextInput = { ownership: complete.ownership }
void missingIdentity

// @ts-expect-error ownership is required
const missingOwnership: CreateExecutionContextInput = { identity: complete.identity }
void missingOwnership

// Finite grants must be explicit; omission cannot mean universe.
const missingGrant: CreateExecutionContextInput = {
  ...complete,
  // @ts-expect-error compartments is required on resolved access
  access: {
    workspaceId: 'workspace-1',
    userId: 'user-1',
    assistantId: 'assistant-1',
    assistantKind: 'standard',
    clearance: 'internal',
    mutationCompartments: [],
    projectIds: [],
    visibilityAssistantIds: [],
  },
}
void missingGrant
