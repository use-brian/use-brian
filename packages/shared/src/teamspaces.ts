import { z } from 'zod'

/** Stored Teamspace metadata returned by PATCH. */
export const teamspaceMetadataSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  /** Optional emoji, same convention as saved_views.icon. */
  icon: z.string().nullable(),
  description: z.string().nullable(),
  sensitivity: z.enum(['public', 'internal', 'confidential']),
  // Servers predating Team linking leave this field out.
  workspaceGroupId: z.string().nullable().default(null),
  /** General cannot be deleted or left. */
  isDefault: z.boolean(),
  position: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** List and create additionally report the roster count and caller's authority. */
export const teamspaceSchema = teamspaceMetadataSchema.extend({
  memberCount: z.number().int().nonnegative(),
  /** Management affordances use this server-derived clearance decision. */
  canManage: z.boolean(),
})

export type TeamspaceMetadata = z.infer<typeof teamspaceMetadataSchema>
export type Teamspace = z.infer<typeof teamspaceSchema>
