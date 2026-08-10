"use client";

/**
 * Google Drive Picker (app-web).
 *
 * Ported from `apps/web/src/components/drive-picker.tsx`
 * (app consolidation §9 #5). Loads the gapi + picker libraries, fetches a
 * short-lived OAuth access token from the backend, and opens the Picker so the
 * user can grant per-file access to the gdrive connector. Picked files flow to
 * the caller via `onPicked`; the caller is responsible for POSTing them to
 * `/api/connectors/gdrive/authorized-files`.
 *
 * Managed connections use `NEXT_PUBLIC_GOOGLE_API_KEY` and
 * `NEXT_PUBLIC_GOOGLE_PROJECT_NUMBER`. BYO connections receive the matching
 * customer Picker key + app id from the exact-instance access-token response.
 *
 * See docs/architecture/integrations/mcp.md → "The `gdrive` connector".
 *
 * [COMP:app-web/drive-picker]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Script from "next/script";
import { authFetch } from "@/lib/auth-fetch";
import { useT } from "@/lib/i18n/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const GOOGLE_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_API_KEY ?? "";
const GOOGLE_PROJECT_NUMBER = process.env.NEXT_PUBLIC_GOOGLE_PROJECT_NUMBER ?? "";

export type PickedFile = {
  id: string;
  name: string;
  mimeType: string;
};

// Minimal ambient typing for the subset of `google.picker` we actually touch.
// Full typings live in @types/google.picker but we don't depend on that package.
type PickerDocument = {
  id: string;
  name: string;
  mimeType: string;
};

type PickerCallbackData = {
  action: string;
  docs?: PickerDocument[];
};

type PickerInstance = {
  setVisible: (visible: boolean) => PickerInstance;
};

interface PickerBuilder {
  setOAuthToken: (token: string) => PickerBuilder;
  setDeveloperKey: (key: string) => PickerBuilder;
  setAppId: (id: string) => PickerBuilder;
  addView: (view: unknown) => PickerBuilder;
  enableFeature: (feature: string) => PickerBuilder;
  setCallback: (cb: (data: PickerCallbackData) => void) => PickerBuilder;
  build: () => PickerInstance;
}

interface DocsView {
  setMimeTypes: (mimeTypes: string) => DocsView;
  setSelectFolderEnabled: (enabled: boolean) => DocsView;
}

type GooglePicker = {
  picker: {
    PickerBuilder: new () => PickerBuilder;
    DocsView: new (viewId?: unknown) => DocsView;
    ViewId: { DOCS: unknown; SPREADSHEETS: unknown; PRESENTATIONS: unknown };
    Action: { PICKED: string; CANCEL: string };
    Feature: { MULTISELECT_ENABLED: string; SUPPORT_DRIVES: string };
  };
};

declare global {
  interface Window {
    gapi?: {
      load: (name: string, cb: () => void) => void;
    };
    google?: GooglePicker;
  }
}

type PickerReadyState = {
  /** The Picker script is loaded. Credential readiness is checked on open. */
  ready: boolean;
  /** If not ready, why. Surfaced as a tooltip/message. */
  disabledReason?: string;
};

type DrivePickerProps = {
  /** Whether the picker trigger is mounted. */
  children: (
    props: {
      open: () => void;
      isOpening: boolean;
      disabled: boolean;
      disabledReason?: string;
    } & PickerReadyState,
  ) => React.ReactNode;
  onPicked: (files: PickedFile[]) => void;
  onError?: (message: string) => void;
  /** File consent for Brian OAuth, or recursive-root selection for BYO OAuth. */
  mode?: "files" | "folders";
  /** Binds the Picker token to the exact Drive account in multi-account setups. */
  connectorInstanceId?: string;
};

export function DrivePicker({
  children,
  onPicked,
  onError,
  mode = "files",
  connectorInstanceId,
}: DrivePickerProps) {
  const t = useT();
  const [apiLoaded, setApiLoaded] = useState(false);
  const [pickerLoaded, setPickerLoaded] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const lastTokenRef = useRef<{
    token: string;
    expiresAt: number;
    pickerApiKey: string;
    pickerAppId: string;
  } | null>(null);

  // Load the `picker` module once gapi itself has loaded.
  useEffect(() => {
    if (!apiLoaded || pickerLoaded) return;
    if (!window.gapi) return;
    window.gapi.load("picker", () => setPickerLoaded(true));
  }, [apiLoaded, pickerLoaded]);

  const getAccessToken = useCallback(async () => {
    const cached = lastTokenRef.current;
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached;

    const qs = connectorInstanceId
      ? `?${new URLSearchParams({ connectorInstanceId })}`
      : "";
    const res = await authFetch(`${API_URL}/api/connectors/gdrive/access-token${qs}`);
    if (!res.ok) {
      throw new Error(
        res.status === 409 ? t.drivePicker.connectFirst : t.drivePicker.noToken,
      );
    }
    const body = (await res.json()) as {
      accessToken: string;
      expiresIn: number;
      pickerApiKey?: string;
      pickerAppId?: string;
    };
    const session = {
      token: body.accessToken,
      expiresAt: Date.now() + body.expiresIn * 1000,
      pickerApiKey: body.pickerApiKey ?? GOOGLE_API_KEY,
      pickerAppId: body.pickerAppId ?? GOOGLE_PROJECT_NUMBER,
    };
    lastTokenRef.current = session;
    return session;
  }, [connectorInstanceId, t]);

  const open = useCallback(async () => {
    if (!pickerLoaded || !window.google?.picker) {
      onError?.(t.drivePicker.loading);
      return;
    }

    setIsOpening(true);
    try {
      const session = await getAccessToken();
      if (!session.pickerApiKey || !session.pickerAppId) {
        onError?.(t.drivePicker.notConfigured);
        return;
      }
      const picker = window.google.picker;

      const builder = new picker.PickerBuilder()
        .setOAuthToken(session.token)
        .setDeveloperKey(session.pickerApiKey)
        .setAppId(session.pickerAppId)
        .enableFeature(picker.Feature.MULTISELECT_ENABLED)
        .enableFeature(picker.Feature.SUPPORT_DRIVES);

      if (mode === "folders") {
        const folderView = new picker.DocsView(picker.ViewId.DOCS);
        folderView.setMimeTypes("application/vnd.google-apps.folder");
        folderView.setSelectFolderEnabled(true);
        builder.addView(folderView);
      } else {
        const docsView = new picker.DocsView(picker.ViewId.DOCS);
        docsView.setSelectFolderEnabled(false);
        builder.addView(docsView);
        builder.addView(new picker.DocsView(picker.ViewId.SPREADSHEETS));
        builder.addView(new picker.DocsView(picker.ViewId.PRESENTATIONS));
      }

      builder
        .setCallback((data) => {
          if (data.action === picker.Action.PICKED && data.docs?.length) {
            onPicked(
              data.docs.map((d) => ({ id: d.id, name: d.name, mimeType: d.mimeType })),
            );
          }
        })
        .build()
        .setVisible(true);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : t.drivePicker.pickerFailed);
    } finally {
      setIsOpening(false);
    }
  }, [pickerLoaded, getAccessToken, mode, onPicked, onError, t]);

  // A BYO instance may be fully configured even when this deployment has no
  // managed Picker metadata, so credential readiness is resolved on open.
  const disabled = !pickerLoaded;
  const disabledReason = !pickerLoaded ? t.drivePicker.loadingPicker : undefined;
  const ready = pickerLoaded;

  return (
    <>
      <Script
        src="https://apis.google.com/js/api.js"
        strategy="afterInteractive"
        onLoad={() => setApiLoaded(true)}
      />
      {children({ open, isOpening, disabled, disabledReason, ready })}
    </>
  );
}
