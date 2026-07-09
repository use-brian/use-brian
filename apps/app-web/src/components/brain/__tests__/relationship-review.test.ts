import { describe, expect, it } from "vitest";
import { endpointPrimitive } from "../relationship-review";

describe("[COMP:app-web/relationship-review] endpointPrimitive", () => {
  it("maps resolvable endpoint kinds to their inbox single-row primitive", () => {
    expect(endpointPrimitive("memory")).toBe("memory");
    expect(endpointPrimitive("file")).toBe("workspace_file");
    expect(endpointPrimitive("task")).toBe("task");
    expect(endpointPrimitive("entity")).toBe("entity");
  });

  it("returns null for endpoint kinds with no single-row surface", () => {
    // episode / event / kb_chunk have no `fetchBrainRow` surface, so their
    // cards render without an expander rather than fetching a 404.
    expect(endpointPrimitive("episode")).toBeNull();
    expect(endpointPrimitive("event")).toBeNull();
    expect(endpointPrimitive("kb_chunk")).toBeNull();
    expect(endpointPrimitive("")).toBeNull();
  });

  it("returns null for skill / assistant — not brain-inbox primitives", () => {
    // A skill endpoint (the `learned_from` source) lives in `workspace_skills`,
    // not the review union, so it has no `fetchBrainRow` primitive. The card
    // still expands: `EndpointCard` routes a skill through `getWorkspaceSkill`
    // (its own `isSkill` branch), not `endpointPrimitive`. Assistant endpoints
    // resolve a name server-side but have no in-Brain preview surface.
    expect(endpointPrimitive("skill")).toBeNull();
    expect(endpointPrimitive("assistant")).toBeNull();
  });
});
