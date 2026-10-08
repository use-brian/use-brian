/** Office chrome composes the app primitives; artifact canvas styling stays local.
 * [COMP:app-web/office-chrome] */
import { buttonVariants } from "@/components/ui/button";

const field = "min-w-0 rounded-lg border border-input bg-background font-normal text-foreground outline-none transition-shadow placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/20";
export const officeInputClassName = `${field} h-9 max-md:min-h-11 px-3 text-base md:text-sm`;
export const officeTextareaClassName = `${field} w-full resize-y px-3 py-2 text-base leading-relaxed md:text-sm`;
export const officeToolbarButtonClassName = buttonVariants({ variant: "ghost", size: "sm", className: "h-8 max-md:min-h-11 text-xs text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground" });
export const officeIconButtonClassName = buttonVariants({ variant: "ghost", size: "icon", className: "max-md:size-11 text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground" });
export const officeDialogBackdropClassName = "fixed inset-0 z-50 bg-background/80 backdrop-blur-sm";
export const officeDialogClassName = "fixed inset-0 z-50 h-dvh w-full overflow-y-auto bg-background p-5 outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:p-6 sm:shadow-xl sm:ring-1 sm:ring-foreground/5";
export const officeWarningClassName = "border-amber-500/25 bg-amber-500/10 text-amber-800 dark:text-amber-200";
export const officeFamilyBadgeClassName = "absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-md border border-border bg-background/95 px-2 py-1 text-xs font-medium text-foreground shadow-sm";
