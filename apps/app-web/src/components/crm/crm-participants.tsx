"use client";

import { useEffect, useMemo, useState } from "react";
import { UserPlus, UsersRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { TextFieldCell } from "./crm-cells";

export function CrmParticipants({ workspaceId, dealId, contacts, initialParticipants, onChanged }: {
  workspaceId: string;
  dealId: string;
  contacts: CrmContactRow[];
  initialParticipants: CrmDealParticipant[];
  onChanged: () => void;
}) {
  const t = useT().crmPage.r2;
  const [participants, setParticipants] = useState<CrmDealParticipant[]>(initialParticipants);
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  async function reload(showLoading = true) {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      setParticipants(await listCrmDealParticipants(workspaceId, dealId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.participantsLoadFailed);
    } finally {
      if (showLoading) setLoading(false);
    }
  }
  useEffect(() => {
    setParticipants(initialParticipants);
    void reload(initialParticipants.length === 0);
  }, [workspaceId, dealId, initialParticipants]);
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
          void addCrmDealParticipant(workspaceId, dealId, contactId, {
            isPrimary: participants.length === 0,
          })
            .then(() => {
              setAdding(false);
              onChanged();
              void reload();
            })
            .catch((cause) => setError(cause instanceof Error ? cause.message : t.participantChangeFailed));
        }}>
          <SelectTrigger className="mb-2 w-full"><SelectValue placeholder={t.pickContact} /></SelectTrigger>
          <SelectContent>{available.map((contact) => <SelectItem key={contact.id} value={contact.id}>{contact.name}{contact.email ? ` · ${contact.email}` : ""}</SelectItem>)}</SelectContent>
        </Select>
      )}
      {error && <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-destructive/5 px-2.5 py-2 text-xs text-destructive"><span>{error}</span><Button size="xs" variant="ghost" onClick={() => void reload()}>{t.retry}</Button></div>}
      <div className="space-y-1.5">
        {participants.map((participant) => (
          <div key={participant.contactId} className="rounded-lg bg-muted/30 px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0"><div className="truncate text-xs font-medium">{participant.name}{participant.isPrimary ? <span className="ml-1.5 text-[10px] text-muted-foreground">{t.primaryContact}</span> : null}</div>{participant.email && <div className="truncate text-[10px] text-muted-foreground">{participant.email}</div>}</div>
              <Button size="icon-xs" variant="ghost" aria-label={t.removeParticipant} onClick={() => void removeCrmDealParticipant(workspaceId, dealId, participant.contactId).then(() => { onChanged(); return reload(); }).catch((cause) => setError(cause instanceof Error ? cause.message : t.participantChangeFailed))}><X aria-hidden /></Button>
            </div>
            <div className="mt-2 flex items-center gap-2 border-t border-border/50 pt-2">
              <div className="min-w-0 flex-1">
                <TextFieldCell
                  value={participant.role ?? ""}
                  placeholder={t.participantRole}
                  ariaLabel={t.participantRole}
                  onCommit={async (role) => {
                    try {
                      await addCrmDealParticipant(workspaceId, dealId, participant.contactId, {
                        role: role?.trim() || null,
                        isPrimary: participant.isPrimary,
                      });
                      onChanged();
                      await reload(false);
                      return { ok: true };
                    } catch (cause) {
                      return { ok: false, error: cause instanceof Error ? cause.message : t.participantChangeFailed };
                    }
                  }}
                />
              </div>
              <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                <Checkbox
                  checked={participant.isPrimary}
                  aria-label={t.primaryContact}
                  onCheckedChange={(checked) => {
                    if (!checked || participant.isPrimary) return;
                    void addCrmDealParticipant(workspaceId, dealId, participant.contactId, {
                      role: participant.role,
                      isPrimary: true,
                    }).then(() => {
                      onChanged();
                      void reload(false);
                    }).catch((cause) => setError(cause instanceof Error ? cause.message : t.participantChangeFailed));
                  }}
                />
                {t.primaryContact}
              </label>
            </div>
          </div>
        ))}
        {loading ? <div className="text-xs text-muted-foreground">{t.participantsLoading}</div> : !error && participants.length === 0 && <div className="text-xs text-muted-foreground">{t.noParticipants}</div>}
      </div>
    </section>
  );
}
