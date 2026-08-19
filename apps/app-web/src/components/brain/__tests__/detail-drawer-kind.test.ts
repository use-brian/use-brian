import { describe, expect, it } from "vitest";
import { brainKindToInboxPrimitive } from "../detail-drawer";
import type { EntityKind } from "@/lib/api/brain";

const ENTITY_KINDS: EntityKind[] = [
  "person",
  "company",
  "project",
  "deal",
  "product",
  "repository",
  "other",
];

describe("[COMP:app-web/brain-detail-drawer] entity kind routing", () => {
  it("loads inbox detail for every canonical entity kind", () => {
    for (const kind of ENTITY_KINDS) {
      expect(brainKindToInboxPrimitive(kind)).toBe("entity");
    }
  });
});
