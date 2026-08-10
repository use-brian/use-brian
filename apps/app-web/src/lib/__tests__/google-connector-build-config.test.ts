import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relativeUrl: string): string {
  return readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), "utf8");
}

describe("[COMP:app-web/connector-oauth-callbacks] Google connector deployment configuration", () => {
  it("keeps the OAuth secret runtime-only while exposing public browser metadata", () => {
    const nextConfig = read("../../../next.config.ts");
    const callback = read("../../app/api/auth/callback/google-connector/route.ts");
    const turbo = JSON.parse(read("../../../../../turbo.json")) as {
      tasks: { build: { env: string[] } };
    };

    expect(nextConfig).toContain("process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID");
    expect(nextConfig).toContain("process.env.NEXT_PUBLIC_GOOGLE_API_KEY");
    expect(nextConfig).toContain("process.env.NEXT_PUBLIC_GOOGLE_PROJECT_NUMBER");
    expect(nextConfig).not.toContain("GOOGLE_CLIENT_SECRET");
    expect(turbo.tasks.build.env).not.toContain("GOOGLE_CLIENT_SECRET");
    expect(callback).toContain('process.env.GOOGLE_CLIENT_ID ?? ""');
    expect(callback).toContain('process.env.GOOGLE_CLIENT_SECRET ?? ""');
  });

  it("uses the configured OSS public origin behind a loopback reverse proxy", () => {
    const callback = read("../../app/api/auth/callback/google-connector/route.ts");

    expect(callback).toContain(
      "isOssEdition() ? process.env.APP_URL ?? request.url : request.url",
    );
    expect(callback).toContain(
      "const redirectUri = `${appOrigin}/api/auth/callback/google-connector`",
    );
    expect(callback).not.toContain("const origin = new URL(request.url).origin");
    expect(callback).not.toContain(
      'new URL(connectorsPath(workspaceId, { error: "token_exchange_failed" }), request.url)',
    );
  });
});

describe("[COMP:app-web/studio-connectors] Google Drive connection choices", () => {
  it("wires managed Picker and workspace BYO OAuth to different exchanges", () => {
    const page = read("../../app/w/[workspaceId]/studio/connectors/page.tsx");
    const callback = read("../../app/api/auth/callback/google-connector/route.ts");

    expect(page).toContain("tc.gdriveConnect.managedTitle");
    expect(page).toContain("tc.gdriveConnect.byoTitle");
    expect(page).toContain("/api/connectors/gdrive/app-credentials");
    expect(page).toContain("gdriveProjectNumber");
    expect(page).toContain("gdrivePickerApiKey");
    expect(page).toContain('stateConnector: "gdrive-byo"');
    expect(page).toContain('sel.driveAccessMode !== "full_drive_readonly"');
    expect(callback).toContain("/api/connectors/gdrive/oauth-callback");
    // The customer secret is resolved by the API, never by this callback.
    expect(callback).not.toContain("GDRIVE_CLIENT_SECRET");
  });

  it("offers post-connect Entire Drive or recursive folder cataloging with a confirmed estimate", () => {
    const page = read("../../app/w/[workspaceId]/studio/connectors/page.tsx");
    const picker = read("../../components/drive-picker.tsx");

    expect(page).toContain("GDriveCatalogScopePanel");
    expect(page).toContain("/api/connectors/gdrive/catalog-estimate");
    expect(page).toContain("/api/connectors/gdrive/catalog-scope");
    expect(page).toContain("/api/connectors/gdrive/catalog-status");
    expect(page).toContain('mode="folders"');
    expect(page).toContain("confirmDialog");
    expect(picker).toContain('mode?: "files" | "folders"');
    expect(picker).toContain("setSelectFolderEnabled(true)");
    expect(picker).toContain("application/vnd.google-apps.folder");
    expect(picker).toContain("connectorInstanceId");
    expect(picker).toContain("body.pickerApiKey ?? GOOGLE_API_KEY");
    expect(picker).toContain("body.pickerAppId ?? GOOGLE_PROJECT_NUMBER");
  });
});
