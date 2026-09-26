/** Managed target authorization injected by the edition, never inferred from display data. */
import type { FeedLinkedInContext } from '@use-brian/shared'
import { FeedCollaborationError, type FeedActor, type FeedScope } from '../db/feed-collaboration-store.js'
type TargetAuthority = (actor: FeedActor, scope: FeedScope, context: FeedLinkedInContext) => Promise<void>
let authorize: TargetAuthority | undefined
export function setFeedLinkedInTargetAuthority(port: TargetAuthority): void { authorize = port }
export async function assertFeedLinkedInDestination(actor: FeedActor, scope: FeedScope, context: FeedLinkedInContext): Promise<void> {
  if (!context.destinationId) return
  if (!authorize) throw new FeedCollaborationError(403, 'linkedin_destination_unavailable')
  await authorize(actor, scope, context)
}
