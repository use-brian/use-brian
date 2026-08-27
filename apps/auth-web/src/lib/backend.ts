import { portalConfig } from "./config";

export function backendUrl(path: string): string {
  return new URL(path, portalConfig().internalApiUrl).toString();
}
