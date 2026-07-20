import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import { ThemeProvider, THEME_PREPAINT_SCRIPT } from "@/lib/theme";
import { I18nProvider } from "@/lib/i18n/client";
import { getServerDictionary } from "@/lib/i18n/server";
import { ConfirmDialogProvider } from "@/components/ui/confirm-dialog";
import { PromptDialogProvider } from "@/components/ui/prompt-dialog";
import { KindPickerDialogProvider } from "@/components/ui/kind-picker-dialog";
import { RouteProgress } from "@/components/route-progress";
import "./globals.css";

// Mirror apps/web's font system: `--font-rocknroll` is a CSS variable
// pointing at a system Chinese-friendly sans stack (PingFang TC, Noto
// Sans TC). The variable lives in globals.css; no Google Font is loaded
// for the body face anymore — RocknRoll_One looked playful but didn't
// match the main app surface. Mono stays JetBrains_Mono for code.
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

const APP_DESCRIPTION =
  "Your company brain: tasks, CRM, knowledge, and workflows in one AI workspace.";

export const metadata: Metadata = {
  metadataBase: new URL("https://app.usebrian.ai"),
  // Use Brian is the whole authenticated app; "Doc" is just its default tab
  // (alongside Brain, Studio, Workflow, …), so the app-level title/brand is
  // "Use Brian" — not "Doc by Use Brian". A page with its own title renders as
  // "<page> · Use Brian" via the template.
  title: {
    default: "Use Brian",
    template: "%s · Use Brian",
  },
  description: APP_DESCRIPTION,
  applicationName: "Use Brian",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon.png", type: "image/png", sizes: "512x512" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
  openGraph: {
    type: "website",
    siteName: "Use Brian",
    title: "Use Brian",
    description: APP_DESCRIPTION,
    url: "/",
    images: [{ url: "/icon.png", width: 512, height: 512, alt: "Use Brian" }],
  },
  twitter: {
    card: "summary",
    title: "Use Brian",
    description: APP_DESCRIPTION,
    images: ["/icon.png"],
  },
  robots: {
    // Authenticated app — no public content. Discourage indexing across the board.
    index: false,
    follow: false,
  },
  other: {
    "color-scheme": "light dark",
  },
};

// Tag <html> before first paint when we're running inside the Electron desktop
// shell (apps/app-desktop), whose preload exposes `window.usebrianDesktop` (+ legacy `window.sidanclawDesktop`)
// BEFORE any page script runs. The `is-canvas-desktop` class gates desktop-only
// chrome in globals.css (a draggable title-bar strip that clears the macOS
// traffic lights + non-selectable app chrome) and is a no-op in the browser.
// On Windows (`platform === "win32"`) the window keeps a standard OS frame with
// no traffic lights, so `is-canvas-desktop-win` zeroes the title-bar inset.
// Same run-before-paint, no-flash shape as THEME_PREPAINT_SCRIPT; no user input.
const DESKTOP_SHELL_PREPAINT_SCRIPT = `(()=>{try{var d=window.usebrianDesktop||window.sidanclawDesktop;if(!d)return;var c=document.documentElement.classList;c.add("is-canvas-desktop");if(d.platform==="win32")c.add("is-canvas-desktop-win");}catch(e){}})();`;

// iOS Safari zooms the page when a form control with a computed font-size
// under 16px receives focus, and the zoom persists after blur — the app then
// reads as "loaded zoomed in" until the user pinches out. Capping
// maximum-scale suppresses that auto-zoom; iOS has ignored maximum-scale for
// *user* pinch gestures since iOS 10, so accessibility zoom still works.
// iOS-only (iPadOS reports MacIntel + touch): Android Chrome honors the cap
// by blocking pinch zoom and never auto-zooms inputs, so it must not get it.
// Re-runs on DOMContentLoaded so it wins regardless of where the framework
// emits the default viewport meta. Mirrors apps/web's layout; spec in
// docs/architecture/features/web-ui.md → "Mobile viewport (iOS input zoom)".
const IOS_VIEWPORT_PATCH_SCRIPT = `(()=>{try{var p=function(){try{var ios=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);if(!ios)return;var m=document.querySelector('meta[name="viewport"]');if(!m){m=document.createElement("meta");m.name="viewport";document.head.appendChild(m);}m.setAttribute("content","width=device-width, initial-scale=1, maximum-scale=1");}catch(e){}};p();if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",p);}catch(e){}})();`;

// Theme is user-switchable. THEME_PREPAINT_SCRIPT (a constant we ship,
// no user input) runs before paint to read the saved choice from
// localStorage and stamp the `dark` class onto <html>, avoiding a
// light-mode flash for users who previously picked dark.
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { locale, dict } = await getServerDictionary();
  return (
    <html
      lang={locale}
      className={`${jetbrainsMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: DESKTOP_SHELL_PREPAINT_SCRIPT }}
        />
        <script
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: THEME_PREPAINT_SCRIPT }}
        />
        <script
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: IOS_VIEWPORT_PATCH_SCRIPT }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        {/* Global navigation progress bar — the desktop shell has no browser
            chrome, so this is the only "navigation in flight" signal on a click
            that triggers a route transition. Mounted here so it spans every
            surface. See docs/architecture/features/doc.md → "Navigation progress". */}
        <RouteProgress />
        <I18nProvider locale={locale} dict={dict}>
          <ThemeProvider>{children}</ThemeProvider>
          <ConfirmDialogProvider />
          <PromptDialogProvider />
          <KindPickerDialogProvider />
        </I18nProvider>
      </body>
    </html>
  );
}
