"use client";

import { useEffect, useMemo, useState } from "react";
import { UserPlus, UsersRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  addCrmDealParticipant,
  listCrmDealParticipants,
  removeCrmDealParticipant,
  type CrmContactRow,
  type CrmDealParticipant,
} from "@/lib/api/crm";
import { useT } from "@/lib/i18n/client";

export function CrmParticipants({ workspaceId, dealId, contacts }: {
  workspaceId: string;
  dealId: string;
  contacts: CrmContactRow[];
}) {
  const t = useT().crmPage.r2;
  const [participants, setParticipants] = useState<CrmDealParticipant[]>([]);
  const [adding, setAdding] = useState(false);
  async function reload() {
    setParticipants(await listCrmDealParticipants(workspaceId, dealId));
  }
  useEffect(() => { void reload().catch(() => setParticipants([])); }, [workspaceId, dealId]);
  const available = useMemo(() => {
    const present = new Set(participants.map((row) => row.contactId));
    return contacts.filter((row) => !present.has(row.id));
  }, [contacts, participants]);

  return (
    <section className="mt-4 border-t border-border/60 pt-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60"><UsersRound className="size-3.5" aria-hidden />{t.dealParticipants}</div>
        {available.length > 0 && <Button size="xs" variant="ghost" onClick={() => setAdding(!adding)}><UserPlus aria-hidden />{t.addParticipant}</Button>}
      </div>
      {adding && (
        <Select onValueChange={(contactId) => {
          if (typeof contactId !== "string") return;
          void addCrmDealParticipant(workspaceId, dealId, contactId).then(() => {
            setAdding(false);
            void reload();
          });
        }}>
          <SelectTrigger className="mb-2 w-full"><SelectValue placeholder={t.pickContact} /></SelectTrigger>
          <SelectContent>{available.map((contact) => <SelectItem key={contact.id} value={contact.id}>{contact.name}{contact.email ? ` · ${contact.email}` : ""}</SelectItem>)}</SelectContent>
        </Select>
      )}
      <div className="space-y-1.5">
        {participants.map((participant) => (
          <div key={participant.contactId} className="flex items-center justify-between rounded-lg bg-muted/30 px-2.5 py-2">
            <div className="min-w-0"><div className="truncate text-xs font-medium">{participant.name}{participant.isPrimary ? <span className="ml-1.5 text-[10px] text-muted-foreground">{t.primaryContact}</span> : null}</div>{participant.email && <div className="truncate text-[10px] text-muted-foreground">{participant.email}</div>}</div>
            <Button size="icon-xs" variant="ghost" aria-label={t.removeParticipant} onClick={() => void removeCrmDealParticipant(workspaceId, dealId, participant.contactId).then(reload)}><X aria-hidden /></Button>
          </div>
        ))}
        {participants.length === 0 && <div className="text-xs text-muted-foreground">{t.noParticipants}</div>}
      </div>
    </section>
  );
}
