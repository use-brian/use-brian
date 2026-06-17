"use client";

/**
 * The working claw — an ambient pixel-claw that paces + waddles in the page
 * background while an assistant run is active, plus a small status pill naming
 * who set it working and how it's going. The at-a-glance "the assistant is
 * working on this page" signal for every member viewing the page (a simplified
 * port of the landing page's `WanderingMonster`, `apps/web/src/app/page.tsx`).
 *
 * Purely presentational — visibility is driven by `useAssistantRun` in the
 * shell, which passes the live `run` (or null). The claw layer is
 * `pointer-events-none` and sits at a low z behind the editor content; the pill
 * announces politely for screen readers. Theme-token coloured (dark/light
 * aware), and the motion is disabled under `prefers-reduced-motion`.
 *
 * See `docs/architecture/features/doc.md` → "The working claw".
 *
 * [COMP:app-web/assistant-run-claw]
 */

import { useEffect, useState } from "react";
import type { AssistantRunState } from "@sidanclaw/doc-model";
import { useT, format } from "@/lib/i18n/client";

// The claw bitmap — the landing page's `MONSTER.small`. '#' = body cell,
// '@' = an eye cell (body with a dark inset), '.' = empty.
const CLAW_ROWS = ["..###..", ".#####.", "##@#@##", "#######", ".#####.", "..#.#.."];
const CELL = 5; // px per pixel-grid cell

function ClawSprite() {
  const cols = CLAW_ROWS[0].length;
  return (
    <div
      className="claw-waddle"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, ${CELL}px)`,
        gap: "1px",
        filter: "drop-shadow(0 1px 2px color-mix(in srgb, var(--primary) 35%, transparent))",
      }}
    >
      {CLAW_ROWS.flatMap((row, y) =>
        [...row].map((cell, x) => {
          if (cell === ".")
            return <span key={`${y}-${x}`} style={{ width: CELL, height: CELL }} />;
          return (
            <span
              key={`${y}-${x}`}
              style={{
                width: CELL,
                height: CELL,
                position: "relative",
                backgroundColor: "var(--primary)",
              }}
            >
              {cell === "@" ? (
                <span
                  style={{
                    position: "absolute",
                    inset: "20%",
                    backgroundColor: "rgba(0,0,0,0.55)",
                  }}
                />
              ) : null}
            </span>
          );
        }),
      )}
    </div>
  );
}

function stepLabel(
  step: AssistantRunState["step"],
  t: { stepWriting: string; stepUpdating: string; stepRemoving: string; stepWorking: string },
): string {
  switch (step?.op) {
    case "add":
      return t.stepWriting;
    case "delete":
      return t.stepRemoving;
    case "edit":
    case "move":
    case "setTitle":
    case "setIcon":
      return t.stepUpdating;
    default:
      return t.stepWorking;
  }
}

export function AssistantRunClaw({ run }: { run: AssistantRunState | null }) {
  const t = useT().docPage.assistantRun;

  // Tick the elapsed caption once a second while a run is open.
  const [elapsed, setElapsed] = useState(0);
  const startedAt = run?.startedAt ?? 0;
  useEffect(() => {
    if (!run) return;
    const update = () =>
      setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [run, startedAt]);

  if (!run) return null;

  const caption = run.actor?.name
    ? format(t.working, { name: run.actor.name })
    : t.workingAnon;

  return (
    <div className="claw-fade-in pointer-events-none absolute inset-0 z-0 overflow-hidden">
      {/* The pacing claw — low-opacity ambient layer along the lower band. */}
      <div
        aria-hidden
        className="claw-pace absolute bottom-[12%]"
        style={{ opacity: 0.22 }}
      >
        <div className="claw-face">
          <ClawSprite />
        </div>
      </div>

      {/* Status pill — politely announced, bottom-centre, above the claw. */}
      <div
        role="status"
        aria-live="polite"
        aria-label={t.clawAria}
        className="absolute inset-x-0 bottom-5 flex justify-center px-4"
      >
        <span className="inline-flex max-w-full items-center gap-2 rounded-full border border-primary/20 bg-card/90 px-3 py-1.5 text-xs font-medium text-foreground shadow-sm backdrop-blur">
          <span
            aria-hidden
            className="claw-blink size-1.5 shrink-0 rounded-full bg-primary"
          />
          <span className="truncate">{caption}</span>
          <span className="shrink-0 text-muted-foreground">
            {stepLabel(run.step, t)}
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground/70">
            {format(t.elapsed, { seconds: elapsed })}
          </span>
        </span>
      </div>
    </div>
  );
}
