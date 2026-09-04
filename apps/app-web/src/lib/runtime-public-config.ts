import {
  resolveDeploymentProfile,
  type DeploymentProfile,
} from "@use-brian/shared/deployment-capabilities";

export type RuntimePublicConfig = {
  apiUrl: string;
  displayApiUrl: string;
  docSyncUrl: string;
  edition: DeploymentProfile;
  appUrl: string;
  primaryAuthUrl: string;
  browserExtensionId: string;
  googleClientId: string;
  googleApiKey: string;
  googleProjectNumber: string;
  notionClientId: string;
  fathomClientId: string;
  fathomAuthorizeUrl: string;
};

declare global {
  interface Window {
    __USE_BRIAN_PUBLIC_CONFIG__?: RuntimePublicConfig;
  }
}

type PublicConfigEnv = Record<string, string | undefined>;

const DEFAULT_EXTENSION_ID = "nnmbbacnkekaoccmkmlfaghjaamgdpjn";
const DEFAULT_FATHOM_AUTHORIZE_URL = "https://fathom.video/oauth2/authorize";

function publicUrl(
  explicit: string | undefined,
  domain: string | undefined,
  protocol: "https" | "wss",
): string | undefined {
  if (explicit !== undefined) return explicit;
  return domain ? `${protocol}://${domain}` : undefined;
}

export function resolveRuntimePublicConfig(
  env: PublicConfigEnv,
): RuntimePublicConfig {
  const apiUrl =
    publicUrl(env.PUBLIC_API_URL, env.API_DOMAIN, "https") ??
    env.NEXT_PUBLIC_API_URL ??
    "";
  const configuredDisplayApiUrl =
    publicUrl(env.PUBLIC_DISPLAY_API_URL, env.API_DOMAIN, "https") ??
    env.NEXT_PUBLIC_DISPLAY_API_URL;

  return {
    apiUrl,
    displayApiUrl:
      configuredDisplayApiUrl || apiUrl || "http://localhost:4000",
    docSyncUrl:
      publicUrl(env.PUBLIC_DOC_SYNC_URL, env.DOC_SYNC_DOMAIN, "wss") ??
      env.NEXT_PUBLIC_DOC_SYNC_URL ??
      "",
    edition: resolveDeploymentProfile(
      env.USEBRIAN_EDITION ?? env.NEXT_PUBLIC_USEBRIAN_EDITION,
    ),
    appUrl:
      env.PUBLIC_APP_URL ??
      env.NEXT_PUBLIC_APP_URL ??
      "",
    primaryAuthUrl:
      env.PUBLIC_PRIMARY_AUTH_URL ?? env.NEXT_PUBLIC_PRIMARY_AUTH_URL ?? "",
    browserExtensionId:
      env.PUBLIC_BROWSER_EXTENSION_ID ??
      env.NEXT_PUBLIC_BROWSER_EXTENSION_ID ??
      DEFAULT_EXTENSION_ID,
    googleClientId:
      env.PUBLIC_GOOGLE_CLIENT_ID ??
      env.GOOGLE_CLIENT_ID ??
      env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ??
      "",
    googleApiKey:
      env.PUBLIC_GOOGLE_API_KEY ??
      env.NEXT_PUBLIC_GOOGLE_API_KEY ??
      "",
    googleProjectNumber:
      env.PUBLIC_GOOGLE_PROJECT_NUMBER ??
      env.GOOGLE_PROJECT_NUMBER ??
      env.NEXT_PUBLIC_GOOGLE_PROJECT_NUMBER ??
      "",
    notionClientId:
      env.PUBLIC_NOTION_CLIENT_ID ??
      env.NOTION_CLIENT_ID ??
      env.NEXT_PUBLIC_NOTION_CLIENT_ID ??
      "",
    fathomClientId:
      env.PUBLIC_FATHOM_CLIENT_ID ??
      env.FATHOM_CLIENT_ID ??
      env.NEXT_PUBLIC_FATHOM_CLIENT_ID ??
      "",
    fathomAuthorizeUrl:
      env.PUBLIC_FATHOM_AUTHORIZE_URL ??
      env.NEXT_PUBLIC_FATHOM_AUTHORIZE_URL ??
      DEFAULT_FATHOM_AUTHORIZE_URL,
  };
}

export function publicRuntimeConfig(): RuntimePublicConfig {
  if (typeof window !== "undefined") {
    const desktopApiUrl = desktopApiOverride(window.location);
    if (desktopApiUrl) {
      return {
        ...resolveRuntimePublicConfig({}),
        ...window.__USE_BRIAN_PUBLIC_CONFIG__,
        apiUrl: desktopApiUrl,
        displayApiUrl:
          window.__USE_BRIAN_PUBLIC_CONFIG__?.displayApiUrl || desktopApiUrl,
      };
    }
    if (window.__USE_BRIAN_PUBLIC_CONFIG__) {
      return window.__USE_BRIAN_PUBLIC_CONFIG__;
    }
  }

  return resolveRuntimePublicConfig(
    typeof process !== "undefined" ? process.env : {},
  );
}

export function desktopApiOverride(location: {
  protocol: string;
  search: string;
}): string | null {
  if (location.protocol !== "file:") return null;
  return new URLSearchParams(location.search).get("api");
}

export function runtimePublicConfigScript(config: RuntimePublicConfig): string {
  const serialized = JSON.stringify(config)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `window.__USE_BRIAN_PUBLIC_CONFIG__=${serialized};`;
}
