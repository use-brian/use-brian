/** Managed target authorization injected by the edition, never inferred from display data. */
import type { FeedLinkedInContext } from '@use-brian/shared'
import { FeedCollaborationError, type FeedActor, type FeedScope } from '../db/feed-collaboration-store.js'
type TargetAuthority = (actor: FeedActor, scope: FeedScope, context: FeedLinkedInContext) => Promise<{ authorUrn: string; displayName: string }>
let authorize: TargetAuthority | undefined
export function setFeedLinkedInTargetAuthority(port: TargetAuthority): void { authorize = port }
export async function assertFeedLinkedInDestination(actor: FeedActor, scope: FeedScope, context: FeedLinkedInContext): Promise<{ authorUrn: string; displayName: string } | null> {
  if (!context.destinationId) return null
  if (!authorize) throw new FeedCollaborationError(403, 'linkedin_destination_unavailable')
  return authorize(actor, scope, context)
}
let publish:((actor:FeedActor,previewHash:string)=>Promise<unknown>)|undefined
export function setFeedLinkedInPublisher(port:NonNullable<typeof publish>){publish=port}
export function feedLinkedInPublisher(){return publish}
