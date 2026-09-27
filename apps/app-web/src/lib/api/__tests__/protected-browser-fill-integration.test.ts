import { describe, expect, it, vi } from "vitest";
import { createProtectedFillService } from "../../../../../../packages/core/src/sandbox/protected-fill";
import { createProtectedCrmSource } from "../../../../../../packages/api/src/sandbox/protected-fill-crm";
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: "https://api.example" }) }));
import { authFetch } from "@/lib/auth-fetch";
import { createProtectedReferences, protectedFields, protectedReferenceHandoff } from "../protected-browser-fill";

describe("[COMP:app-web/protected-fill] backend service/CRM compatibility", () => {
  it("issues all seven scalar fields and hands off real server-generated metadata only", async () => {
    type Deps = Parameters<typeof createProtectedCrmSource>[0];
    type Entity = NonNullable<Awaited<ReturnType<Deps["entity"]>>>;
    const entityId = "11111111-1111-4111-8111-111111111111";
    const companyId = "22222222-2222-4222-8222-222222222222";
    const sentinel = "PRIVATE_CRM_VALUE";
    const entities = new Map<string, Entity>([
      [entityId, { id: entityId, workspaceId: "ws", kind: "person", displayName: sentinel,
        attributes: { email: sentinel, phone: sentinel, company_id: companyId, job_title: sentinel, address: sentinel, website: sentinel } } as unknown as Entity],
      [companyId, { id: companyId, workspaceId: "ws", kind: "company", displayName: sentinel, attributes: {} } as unknown as Entity],
    ]);
    const service = createProtectedFillService({
      authorize: async () => true,
      ...createProtectedCrmSource({
        viewpoint: async () => ({ userId: "user", workspaceId: "ws" }) as NonNullable<Awaited<ReturnType<Deps["viewpoint"]>>>,
        entity: async (_ctx, id) => entities.get(id) ?? null,
      }),
    });
    const scope = { workspaceId: "ws", sessionId: "session", taskId: "local-session", browserProfileId: "profile", destinationOrigin: "https://target.example" };
    vi.mocked(authFetch).mockImplementation(async (url, init) => {
      expect(url).toBe("https://api.example/api/protected-browser-fill/references");
      const { sources, ...binding } = JSON.parse(init!.body as string);
      expect(binding).toEqual(scope);
      expect(sources).toEqual(protectedFields.map(field => ({ kind: "crm", entityId, field })));
      const body = await service.create({ ...binding, userId: "user" }, sources);
      return { status: 201, json: async () => body } as Response;
    });
    const result = await createProtectedReferences(scope, entityId, [...protectedFields]);
    expect(result.references.map(r => r.field)).toEqual(protectedFields);
    expect(new Set(result.references.map(r => r.referenceId)).size).toBe(7);
    const handoff = protectedReferenceHandoff(result);
    expect(handoff).not.toContain(sentinel);
    expect(handoff).not.toContain(entityId);
    expect(handoff).not.toContain(companyId);
    expect(Object.keys(JSON.parse(handoff))).toEqual(["references"]);
  });
});
