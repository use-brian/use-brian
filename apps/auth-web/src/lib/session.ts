import type { AuthData } from "./cookies";
import { portalConfig } from "./config";
import { safeReturnUrl } from "./origins";

export function sessionRedirect(data: AuthData): URL {
  const config = portalConfig();
  return safeReturnUrl(data.nextPath, config) ?? new URL(config.appOrigin);
}
