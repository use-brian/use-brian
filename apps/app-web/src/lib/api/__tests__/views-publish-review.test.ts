/**
 * [COMP:app-web/share-dialog] Publishing is an explicit declassification
 * (doc.md): the client sends the confirmation and reviewed reason, and turns the
 * server's review refusals into a typed error the dialog can act on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import { publishPage, PublishReviewError } from "@/lib/api/views";

const response = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("[COMP:app-web/share-dialog] publish review contract", () => {
  afterEach(() => vi.mocked(authFetch).mockReset());

  it("sends the declassification and reason with the publish request", async () => {
    vi.mocked(authFetch).mockResolvedValue(response(200, { published: true, indexable: false, role: "view" }));
    await publishPage("page-1", false, undefined, { declassify: true, reason: "Fictional public notes" });
    const [, init] = vi.mocked(authFetch).mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ indexable: false, declassify: true, reason: "Fictional public notes" });
  });

  it.each([
    [409, "not_public"],
    [409, "department_widening_review_required"],
    [403, "department_widening_forbidden"],
  ] as const)("raises a typed review error for %i %s", async (status, code) => {
    vi.mocked(authFetch).mockImplementation(async () => response(status, { code }));
    await expect(publishPage("page-1", false)).rejects.toMatchObject({ name: "PublishReviewError", code });
    await expect(publishPage("page-1", false)).rejects.toBeInstanceOf(PublishReviewError);
  });
});
