import type { BrainRow, EntityKind } from "@/lib/api/brain";
import type { BrainPrimitive as InboxPrimitive } from "@/lib/api/brain-inbox";

export const ENTITY_KINDS = new Set<EntityKind>([
  "person",
  "company",
  "project",
  "deal",
  "product",
  "repository",
  "other",
]);

/** Map a brain-list row kind to the inbox primitive used by the
 *  primitive-detail fetch. Returns null for kinds that don't have a
 *  primitive-shape detail surface (knowledge, sessions). Every canonical
 *  entity kind maps to the 'entity' primitive — derive that branch from
 *  `ENTITY_KINDS` so a newly supported kind cannot leave the drawer's
 *  primitive state loading forever.
 *  Spec: corrections.md → "Entity-kind loading invariant". */
export function brainKindToInboxPrimitive(
  kind: BrainRow["kind"],
): InboxPrimitive | null {
  if (ENTITY_KINDS.has(kind as EntityKind)) return "entity";
  switch (kind) {
    case "memories":
      return "memory";
    case "tasks":
      return "task";
    case "files":
      return "workspace_file";
    case "people":
      return "contact";
    case "companies":
      return "company";
    case "deals":
      return "deal";
    default:
      return null;
  }
}

