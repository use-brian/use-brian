import { LoginForm } from "@/components/login-form";
import { portalConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  const config = portalConfig();
  return <LoginForm
    emailEnabled={config.emailEnabled}
    oidcEnabled={config.oidcEnabled}
    oidcProviderName={config.oidc?.providerName}
  />;
}
