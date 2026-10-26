"use client";

/** Context summary and keyboard geometry; Chat owns every selection and send.
 * Spec: docs/architecture/features/chat-app.md → "Responsive Chat proportions".
 * [COMP:app-web/chat-responsive-controls] */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { FolderKanban, Info, LockKeyhole, SlidersHorizontal, UsersRound, X } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { ModeAwareCreationContext, type CreationContext } from "@/components/context/mode-aware-context";
import { Tooltip } from "@/components/ui/tooltip";

/** Observe the actual pane, rather than assuming a wide window means a wide composer. */
function useCompactLayout() {
  const ref = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const element = ref.current?.parentElement;
    if (!element) return;
    const update = () => setCompact(element.getBoundingClientRect().width < 560);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, compact };
}

/** The visual viewport contracts for an on-screen keyboard even when 100dvh does not. */
export function useChatVisibleViewport() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current, viewport = window.visualViewport;
    if (!element || !viewport) return;
    let frame = 0;
    const clear = () => {
      element.style.removeProperty("--chat-visible-height");
      element.style.removeProperty("--chat-input-max-height");
      element.removeAttribute("data-chat-keyboard-constrained");
      document.documentElement.style.removeProperty("--chat-keyboard-inset");
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
        if (!Number.isFinite(inset) || inset < 80 || (viewport.scale ?? 1) !== 1) { clear(); return; }
        const top = Math.max(0, element.getBoundingClientRect().top - viewport.offsetTop);
        const available = Math.max(0, viewport.height - top);
        element.style.setProperty("--chat-visible-height", `${available}px`);
        element.style.setProperty("--chat-input-max-height", `${Math.max(48, available * 0.35)}px`);
        element.setAttribute("data-chat-keyboard-constrained", "");
        document.documentElement.style.setProperty("--chat-keyboard-inset", `${inset}px`);
      });
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame); clear();
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return ref;
}

function OptionsSheet({ open, onOpenChange, title, description, trigger, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  trigger: ReactNode;
  children: ReactNode;
}) {
  const t = useT().chatApp;
  const close = useRef<HTMLButtonElement>(null);
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    {trigger}
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/25" />
      <Dialog.Popup initialFocus={close} data-chat-options-sheet className="fixed inset-x-0 bottom-[var(--chat-keyboard-inset,0px)] z-50 mx-auto flex max-h-[min(80dvh,calc(100dvh-var(--chat-keyboard-inset,0px)-1rem))] w-full max-w-xl flex-col rounded-t-[20px] border border-border bg-background shadow-xl outline-none pb-[env(safe-area-inset-bottom)]">
        <div className="flex shrink-0 items-center gap-3 px-4 pt-2">
          <Dialog.Title className="min-w-0 flex-1 text-base font-semibold">{title}</Dialog.Title>
          <Dialog.Close ref={close} aria-label={t.closePanel} className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"><X className="size-[18px]" aria-hidden /></Dialog.Close>
        </div>
        <Dialog.Description className="shrink-0 px-4 pb-3 text-sm leading-5 text-muted-foreground">{description}</Dialog.Description>
        <div className="min-h-0 overflow-y-auto px-4 pb-4">{children}</div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

export function ChatContextBar({ context, disabled }: { context: CreationContext; disabled?: boolean }) {
  const copy = useT(), t = copy.chatApp;
  const { ref, compact } = useCompactLayout();
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!compact) setOpen(false); }, [compact]);
  const team = context.choices?.teams.find(team => team.id === context.teamId)?.name ?? copy.contextScope.general;
  const project = context.choices?.projects.find(project => project.id === context.projectId)?.name ?? copy.contextScope.addProject;
  const audience = context.intent === "private" ? t.viewPersonal : t.viewWorkspace;
  const AudienceIcon = context.intent === "private" ? LockKeyhole : UsersRound;
  const review = context.error || context.reviewNeeded;
  return <div ref={ref} data-chat-scope-band className="w-full px-1 pb-2">
    {compact ? <OptionsSheet open={open} onOpenChange={setOpen} title={t.contextSettingsTitle} description={t.contextSettingsDescription}
      trigger={<Dialog.Trigger data-chat-context-summary className="flex min-h-8 max-md:min-h-11 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-xs text-muted-foreground hover:bg-muted">
        <FolderKanban className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{review ? t.reviewContext : !context.ready ? t.chooseContext : `${audience} · ${team} · ${project}`}</span>
        <SlidersHorizontal className="size-4 shrink-0" aria-hidden />
      </Dialog.Trigger>}>
      <ModeAwareCreationContext context={context} disabled={disabled} />
    </OptionsSheet> : <div className="flex min-w-0 items-start gap-2">
      <Tooltip label={t.contextSettingsDescription}>
        <button type="button" aria-label={t.contextSettingsTitle} className="flex min-h-9 max-sm:min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:bg-muted">
          <AudienceIcon className="size-3.5" aria-hidden />{audience}<Info className="size-3" aria-hidden />
        </button>
      </Tooltip>
      <div className="min-w-0 flex-1"><ModeAwareCreationContext context={context} compact disabled={disabled} /></div>
    </div>}
  </div>;
}
