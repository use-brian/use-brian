import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Local OSS ChatGPT-subscription API client.
 *
 * The server returns masked account metadata and reviewed catalog rows only.
 * OAuth tokens never cross this interface.
 *
 * [COMP:app-web/codex-provider]
 */
import { authFetch } from "@/lib/auth-fetch";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";
const BASE = `${API_URL}/api/local/codex`;

type CodexAccountStatus = {
  connected: boolean;
  authType: "chatgpt" | "apiKey" | "amazonBedrock" | "none";
  planType: string | null;
  emailHint: string | null;
  requiresOpenaiAuth: boolean;
};

type CodexCatalogModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  inputModalities: Array<"text" | "image" | "audio">;
};

export type CodexProviderStatus = {
  runtimeAvailable: boolean;
  account: CodexAccountStatus;
  models: CodexCatalogModel[];
  preferredProvider: CodexPreferredProvider;
};

export type CodexPreferredProvider =
  | "auto"
  | "gemini"
  | "openai-codex"
  | "dashscope-intl";

export type BrowserLogin = {
  type: "chatgpt";
  loginId: string;
  authUrl: string;
};

export type DeviceCodeLogin = {
  type: "chatgptDeviceCode";
  loginId: string;
  verificationUrl: string;
  userCode: string;
};

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(`${BASE}${path}`, init);
  if (!res.ok) throw new Error(`ChatGPT provider request failed (${res.status})`);
  return (await res.json()) as T;
}

export function getCodexProviderStatus(): Promise<CodexProviderStatus> {
  return json<CodexProviderStatus>("/status");
}

export function startCodexBrowserLogin(): Promise<BrowserLogin> {
  return json<BrowserLogin>("/login/browser", { method: "POST" });
}

export function startCodexDeviceLogin(): Promise<DeviceCodeLogin> {
  return json<DeviceCodeLogin>("/login/device", { method: "POST" });
}

export function cancelCodexLogin(loginId: string): Promise<{ ok: true }> {
  return json<{ ok: true }>("/login/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId }),
  });
}

export function disconnectCodex(): Promise<{ ok: true }> {
  return json<{ ok: true }>("/logout", { method: "POST" });
}

export function setPreferredProvider(
  preferredProvider: CodexPreferredProvider,
): Promise<{ preferredProvider: CodexPreferredProvider }> {
  return json<{ preferredProvider: CodexPreferredProvider }>("/preference", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preferredProvider }),
  });
}
