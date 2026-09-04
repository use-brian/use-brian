"use client";

/**
 * macOS Electron-only setup entry for the Use Brian Shortcuts action.
 * [COMP:app-web/siri-settings]
 */

import { Button } from "@/components/ui/button";
import {
  isDesktopSiriSetupAvailable,
  openDesktopSiriSetup,
} from "@/lib/desktop-auth-source";
import { useT } from "@/lib/i18n/client";

export function SiriSetupCard() {
  const t = useT();
  if (!isDesktopSiriSetupAvailable()) return null;

  return (
    <section className="border-t border-border pt-6 space-y-4">
      <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
        {t.settings.general.siriTitle}
      </h3>
      <div className="rounded-lg border border-border p-4 md:flex md:items-center md:justify-between md:gap-6">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">{t.settings.general.siriLabel}</p>
          <p className="text-sm text-muted-foreground">
            {t.settings.general.siriDescription}
          </p>
          <p className="text-xs text-muted-foreground">
            {t.settings.general.siriSetupHint}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-4 shrink-0 md:mt-0"
          onClick={() => void openDesktopSiriSetup()}
        >
          {t.settings.general.siriSetup}
        </Button>
      </div>
    </section>
  );
}
