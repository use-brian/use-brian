/**
 * [COMP:app-web/page-social-image] Social thumbnail decisions: title, marks,
 * workspace-picture allowlist, and the image URL a crawler is given.
 */

import { describe, expect, it, vi } from "vitest";
import { buildShareMetadata, type PublicPage } from "@/lib/api/public-share";
import {
  hostForPublicUrl,
  isPublicWorkspaceIconUrl,
  joinSocialImageUrl,
  loadWorkspaceIconRaster,
  notoEmojiPngUrl,
  pageMark,
  requestPublicOrigin,
  siteSocialImageUrl,
  socialCardTitle,
  workspaceIconUrl,
} from "@/lib/page-social-card";

const page = {
  title: "AI Venture",
  icon: "🤖",
  fullWidth: false,
  indexable: false,
  role: "view",
  blocks: [{ kind: "heading", id: "h", text: "Updates / Where idea comes from" }],
  payload: { columns: [], rows: [] },
  workspaceIcon: { url: "https://api.example/api/workspace-icons/ws-1?v=ab", seed: 7 },
} as unknown as PublicPage;

describe("[COMP:app-web/page-social-image] card decisions", () => {
  it("keeps a short title and clips a long one on code points", () => {
    expect(socialCardTitle("  AI   Venture ")).toBe("AI Venture");
    expect(socialCardTitle("")).toBe("Shared page");
    expect(socialCardTitle(null)).toBe("Shared page");
    const long = "あ".repeat(80);
    expect([...socialCardTitle(long)]).toHaveLength(64);
    expect(socialCardTitle(long).endsWith("...")).toBe(true);
  });

  it("points a robot emoji at the Noto color PNG", () => {
    expect(notoEmojiPngUrl("🤖")).toBe("https://fonts.gstatic.com/s/e/notoemoji/latest/1f916/512.png");
    expect(notoEmojiPngUrl("⌨️")).toBe("https://fonts.gstatic.com/s/e/notoemoji/latest/2328/512.png");
  });

  it("draws an emoji page icon and a document glyph for an image token or an empty icon", () => {
    expect(pageMark("🤖")).toEqual({ kind: "emoji", emoji: "🤖" });
    expect(pageMark(null)).toEqual({ kind: "glyph" });
    expect(pageMark("img:00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002")).toEqual({
      kind: "glyph",
    });
  });

  it("accepts only the public workspace-icon proxy", () => {
    expect(isPublicWorkspaceIconUrl("https://api.example/api/workspace-icons/ws-1?v=ab")).toBe(true);
    expect(isPublicWorkspaceIconUrl("http://localhost:4000/api/workspace-icons/ws-1")).toBe(true);
    expect(isPublicWorkspaceIconUrl("https://evil.example/logo.png")).toBe(false);
    expect(isPublicWorkspaceIconUrl("https://user:pass@api.example/api/workspace-icons/ws-1")).toBe(false);
    expect(isPublicWorkspaceIconUrl("javascript:alert(1)")).toBe(false);
    expect(workspaceIconUrl({ workspaceIcon: { url: "https://evil.example/x", seed: 1 } })).toBeNull();
  });

  it("points a customer domain at /assets/social-image, a reserved slug", () => {
    expect(siteSocialImageUrl("asso.example", "/ai-venture")).toBe(
      "https://asso.example/assets/social-image/ai-venture",
    );
    expect(siteSocialImageUrl("asso.example", "/", "http")).toBe("http://asso.example/assets/social-image");
    expect(siteSocialImageUrl("asso.example", null)).toBe("https://asso.example/assets/social-image");
    expect(hostForPublicUrl("asso.example", "asso.example:3000")).toBe("asso.example:3000");
    expect(hostForPublicUrl("asso.example", "other.example")).toBe("asso.example");
  });

  it("builds the share image on the host that served the page", () => {
    expect(requestPublicOrigin("https", "app.example, proxy.internal")).toBe("https://app.example");
    expect(requestPublicOrigin(null, "localhost:3000")).toBe("http://localhost:3000");
    expect(joinSocialImageUrl("https://app.example", "/share/tok/opengraph-image")).toBe(
      "https://app.example/share/tok/opengraph-image",
    );
  });

  it("publishes the page title and the composed image instead of the product icon", () => {
    const meta = buildShareMetadata(page, {
      image: "https://asso.example/assets/social-image/ai-venture",
      pageUrl: "https://asso.example/ai-venture",
    });
    expect(meta.title).toBe("AI Venture");
    expect(meta.description).toBe("Updates / Where idea comes from");
    expect(meta.openGraph?.title).toBe("AI Venture");
    expect(meta.twitter?.title).toBe("AI Venture");
    expect(meta.twitter && "card" in meta.twitter ? meta.twitter.card : undefined).toBe("summary");
    const images = meta.openGraph?.images;
    const first = Array.isArray(images) ? images[0] : images;
    expect(first).toMatchObject({
      url: "https://asso.example/assets/social-image/ai-venture",
      width: 1200,
      height: 1200,
      alt: "AI Venture",
    });
    expect(JSON.stringify(meta)).not.toContain("icon.png");
    expect(JSON.stringify(meta.twitter)).not.toContain("Use Brian");
  });

  it("does not fetch a workspace picture that fails the allowlist", async () => {
    const fetchImpl = vi.fn();
    await expect(loadWorkspaceIconRaster("https://evil.example/logo.png", fetchImpl)).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("embeds a small PNG and skips other types", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const fetchImpl = vi.fn(async () => new Response(png, { headers: { "content-type": "image/png" } }));
    const data = await loadWorkspaceIconRaster("https://api.example/api/workspace-icons/ws-1", fetchImpl);
    expect(data?.startsWith("data:image/png;base64,")).toBe(true);

    const webp = vi.fn(async () => new Response(png, { headers: { "content-type": "image/webp" } }));
    await expect(loadWorkspaceIconRaster("https://api.example/api/workspace-icons/ws-1", webp)).resolves.toBeNull();
  });
});
