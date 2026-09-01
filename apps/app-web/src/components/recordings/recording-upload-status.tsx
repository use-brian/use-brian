"use client";

/**
 * Shared determinate recording-upload status for every composer host.
 * `uploadProgress` is the signed storage PUT fraction (0..1); estimate and
 * processing use separate text-only states because they do not expose
 * meaningful byte progress. This also ends the floating-dock glow as soon as
 * the bytes have transferred instead of leaving it active through preflight.
 *
 * [COMP:web/recording-upload]
 */

import { useT } from "@/lib/i18n/client";
import type { RecordingUploadStatus as Status } from "@/lib/recordings/use-recording-upload";
import { cn } from "@/lib/utils";

type Props = {
  status: Status;
  uploadProgress: number;
  message: string;
  className?: string;
};

export function RecordingUploadStatus({
  status,
  uploadProgress,
  message,
  className,
}: Props) {
  const t = useT().recordings;
  if (status === "idle") return null;

  if (status === "uploading") {
    const percent = Math.round(Math.min(1, Math.max(0, uploadProgress)) * 100);
    const label = t.uploadingProgress.replace("{percent}", String(percent));
    return (
      <div
        className={cn("space-y-1 py-0.5 text-xs text-muted-foreground", className)}
        role="status"
        aria-live="polite"
      >
        <span>{label}</span>
        <div
          className="h-1 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    );
  }

  return (
    <p
      className={cn(
        "py-0.5 text-xs",
        status === "error" ? "text-destructive" : "text-muted-foreground",
        className,
      )}
      role="status"
    >
      {status === "estimating"
        ? t.estimating
        : status === "processing"
          ? t.processing
          : message}
    </p>
  );
}
