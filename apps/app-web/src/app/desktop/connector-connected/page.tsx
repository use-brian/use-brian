import type { Metadata } from "next";
import { getServerDictionary } from "@/lib/i18n/server";

/**
 * Branded landing the desktop (Electron) loopback tab lands on after a connector
 * connect (Google / Notion).
 *
 * The shell's ephemeral `http://127.0.0.1:<port>/cb` server 302s the system
 * browser here once it has captured the OAuth code, so the user never lingers on
 * the bare `127.0.0.1:<port>/cb?code=…` URL. The desktop app does the token
 * exchange + store and refocuses itself onto the connectors page, so this tab is
 * a "you can close this" courtesy; `?status=error` swaps to the "didn't finish"
 * copy (the native dialog still fires in the app).
 *
 * Mirrors `/desktop/signed-in`. Public (not gated by `proxy.ts`). A pure Server
 * Component reading the locale dictionary, so it carries no client JS.
 *
 * Spec: docs/architecture/features/app-desktop.md → "Connector OAuth" and
 * docs/plans/desktop-connector-oauth-return.md.
 * [COMP:app-web/desktop-connector-connected].
 */

export const metadata: Metadata = {
  title: "Connector connected",
};

export default async function DesktopConnectorConnectedPage(props: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await props.searchParams;
  const { dict } = await getServerDictionary();
  const t = dict.desktopConnectorConnected;
  const isError = status === "error";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-center">
      <div className="w-full max-w-sm space-y-5 animate-rise-in">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/icon.png"
          alt=""
          className="mx-auto h-14 w-14 rounded-2xl ring-1 ring-primary/30 shadow-[0_8px_30px_-10px_color-mix(in_srgb,var(--primary)_50%,transparent)]"
        />
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {isError ? t.errorTitle : t.title}
        </h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {isError ? t.errorBody : t.body}
        </p>
      </div>
    </div>
  );
}
