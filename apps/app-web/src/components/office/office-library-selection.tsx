"use client";

/** Scoped selection and retryable lifecycle actions. [COMP:app-web/office-library-selection] */
import { useId, useLayoutEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { officeDialogBackdropClassName, officeDialogClassName, officeInputClassName, officeSelectionCheckboxClassName } from "./office-chrome";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

export type OfficeLibraryAction = "trash" | "restore" | "purge";

export function useOfficeLibrarySelection(scope: string, eligibleIds: string[], available: boolean, mutate: (id: string, action: OfficeLibraryAction) => Promise<unknown>, refresh: () => void, isCurrent: () => boolean = () => available) {
  const [ids, setIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [failedAction, setFailedAction] = useState<OfficeLibraryAction | null>(null);
  const owner = useRef<object | null>(null);
  const locked = useRef(false);
  const eligibility = eligibleIds.join("|");
  useLayoutEffect(() => {
    owner.current = available ? {} : null;
    locked.current = false;
    setIds([]); setPending(false); setFailedAction(null);
    return () => { owner.current = null; };
  }, [scope, available]);
  useLayoutEffect(() => { setIds(current => current.filter(id => eligibleIds.includes(id))); }, [eligibility]); // eslint-disable-line react-hooks/exhaustive-deps
  const selected = available ? ids.filter(id => eligibleIds.includes(id)) : [];
  async function runAction(action: OfficeLibraryAction) {
    const token = owner.current;
    if (!token || !isCurrent() || locked.current || !selected.length) return;
    locked.current = true; setPending(true); setFailedAction(null);
    const results = await Promise.allSettled(selected.map(async id => mutate(id, action)));
    refresh();
    if (owner.current !== token) return;
    const succeeded = selected.filter((_, index) => results[index].status === "fulfilled");
    setIds(current => current.filter(id => !succeeded.includes(id)));
    setFailedAction(results.some(result => result.status === "rejected") ? action : null);
    locked.current = false; setPending(false);
  }
  return { scope, selected, pending, failed: failedAction !== null, failedAction, runAction, moveToTrash: () => runAction("trash"), toggle(id: string, checked: boolean) {
    if (locked.current || !owner.current || !isCurrent() || !eligibleIds.includes(id)) return;
    setFailedAction(null);
    setIds(current => checked ? [...new Set([...current, id])] : current.filter(value => value !== id));
  }, selectAll(checked: boolean) { if (!locked.current && isCurrent()) { setFailedAction(null); setIds(checked ? eligibleIds : []); } } };
}

export function OfficeLibrarySelectionBar({ selection, total, trashView = false, itemNames = {} }: { selection: ReturnType<typeof useOfficeLibrarySelection>; total: number; trashView?: boolean; itemNames?: Record<string, string> }) {
  const copy = useT(), t = copy.office;
  const inputId = useId();
  const [deletion, setDeletion] = useState<{ scope: string; value: string } | null>(null);
  const deletionScope = JSON.stringify([selection.scope, selection.selected.map(id => [id, itemNames[id]])]);
  const deleteOpen = deletion?.scope === deletionScope && selection.selected.length > 0 && !selection.pending;
  useLayoutEffect(() => { setDeletion(null); }, [deletionScope]);
  if (!total) return null;
  return <>
    <div className="flex flex-wrap items-center gap-3" data-office-library-selection="true">
      <label className="flex min-h-11 md:min-h-8 cursor-pointer items-center gap-2 text-sm"><Checkbox className={officeSelectionCheckboxClassName} checked={selection.selected.length === total} indeterminate={selection.selected.length > 0 && selection.selected.length < total} disabled={selection.pending} onCheckedChange={selection.selectAll} /><span>{t.selectAllItems}</span></label>
      <span className="text-sm text-muted-foreground" role="status">{format(t.selectedItems, { count: selection.selected.length })}</span>
      {selection.selected.length ? <>
        <Button variant="ghost" disabled={selection.pending} onClick={() => selection.selectAll(false)}>{t.clearSelection}</Button>
        {trashView ? <><Button variant="outline" disabled={selection.pending} onClick={() => void selection.runAction("restore")}>{t.restore}</Button><Button variant="destructive" disabled={selection.pending} onClick={() => setDeletion({ scope: deletionScope, value: "" })}>{t.deletePermanently}</Button></> : <Button variant="destructive" disabled={selection.pending} onClick={() => void selection.moveToTrash()}>{t.moveToTrash}</Button>}
      </> : null}
      {selection.failed ? <p role="alert" className="text-sm text-destructive">{selection.failedAction === "restore" ? t.bulkRestoreFailed : selection.failedAction === "purge" ? t.bulkDeleteFailed : t.bulkTrashFailed}</p> : null}
    </div>
    <Dialog.Root open={deleteOpen} onOpenChange={open => { if (!open) setDeletion(null); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className={officeDialogBackdropClassName} />
        <Dialog.Popup className={`${officeDialogClassName} sm:max-w-lg`}>
          <Dialog.Title className="text-lg font-semibold">{t.deletePermanently}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">{format(t.bulkDeleteDescription, { count: selection.selected.length })}</Dialog.Description>
          <ul className="my-4 max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-sm">{selection.selected.map(id => <li key={id} className="break-words">{itemNames[id] ?? id}</li>)}</ul>
          <form onSubmit={event => { event.preventDefault(); if (deletion?.scope !== deletionScope || deletion.value !== t.deletePermanently) return; setDeletion(null); void selection.runAction("purge"); }}>
            <label htmlFor={inputId} className="mb-2 block text-sm">{format(t.bulkDeleteConfirmation, { confirmation: t.deletePermanently })}</label>
            <input id={inputId} value={deletion?.value ?? ""} onChange={event => setDeletion({ scope: deletionScope, value: event.target.value })} className={`${officeInputClassName} w-full`} autoComplete="off" autoCapitalize="off" spellCheck={false} />
            <div className="mt-5 flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" onClick={() => setDeletion(null)}>{copy.common.cancel}</Button><Button type="submit" variant="destructive" disabled={deletion?.value !== t.deletePermanently || selection.pending}>{t.deletePermanently}</Button></div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}
