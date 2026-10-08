"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

type ParticipantProps = {
  workspaceId: string;
  dealId: string;
  contacts: CrmContactRow[];
  initialParticipants: CrmDealParticipant[];
  onChanged: () => void;
};

export function CrmParticipants(props: ParticipantProps) {
  return <ParticipantPanel key={JSON.stringify([props.workspaceId, props.dealId])} {...props} />;
}

function ParticipantPanel({ workspaceId, dealId, contacts, initialParticipants, onChanged }: ParticipantProps) {
  const t = useT().crmPage.r2;
  const [participants, setParticipants] = useState<CrmDealParticipant[]>(initialParticipants);
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  async function reload(showLoading = true) {
    const generation = ++requestGeneration.current;
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const rows = await listCrmDealParticipants(workspaceId, dealId);
      if (generation === requestGeneration.current) setParticipants(rows);
    } catch (cause) {
      if (generation !== requestGeneration.current) return;
      setParticipants([]);
      setError(cause instanceof Error ? cause.message : t.participantsLoadFailed);
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }
  useEffect(() => {
    void reload(initialParticipants.length === 0);
    return () => { requestGeneration.current += 1; };
  }, [workspaceId, dealId, initialParticipants]);

  async function change(write: () => Promise<unknown>) {
    const generation = requestGeneration.current;
    try {
      await write();
      if (generation !== requestGeneration.current) return { ok: false, error: t.participantChangeFailed };
      onChanged();
      await reload(false);
      return { ok: true };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t.participantChangeFailed;
      if (generation === requestGeneration.current) {
        requestGeneration.current += 1;
        setParticipants([]);
        setLoading(false);
        setError(message);
      }
      return { ok: false, error: message };
    }
  }
  const available = useMemo(() => {
    const present = new Set(participants.map((row) => row.contactId));
    return contacts.filter((row) => !present.has(row.id));
  }, [contacts, participants]);

  return (
    <section className="mt-4 border-t border-border/60 pt-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60"><UsersRound className="size-3.5" aria-hidden />{t.dealParticipants}</div>
        {!error && available.length > 0 && <Button size="xs" variant="ghost" onClick={() => setAdding(!adding)}><UserPlus aria-hidden />{t.addParticipant}</Button>}
      </div>
      {adding && !error && (
        <Select items={available.map((contact) => ({ value: contact.id, label: `${contact.name}${contact.email ? ` · ${contact.email}` : ""}` }))} onValueChange={(contactId) => {
          if (typeof contactId !== "string") return;
          void change(() => addCrmDealParticipant(workspaceId, dealId, contactId, {
            isPrimary: participants.length === 0,
          })).then((result) => { if (result.ok) setAdding(false); });
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
              <Button size="icon-xs" variant="ghost" aria-label={t.removeParticipant} onClick={() => void change(() => removeCrmDealParticipant(workspaceId, dealId, participant.contactId))}><X aria-hidden /></Button>
            </div>
            <div className="mt-2 flex items-center gap-2 border-t border-border/50 pt-2">
              <div className="min-w-0 flex-1">
                <TextFieldCell
                  value={participant.role ?? ""}
                  placeholder={t.participantRole}
                  ariaLabel={t.participantRole}
                  onCommit={(role) => change(() => addCrmDealParticipant(workspaceId, dealId, participant.contactId, {
                    role: role?.trim() || null,
                    isPrimary: participant.isPrimary,
                  }))}
                />
              </div>
              <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                <Checkbox
                  checked={participant.isPrimary}
                  aria-label={t.primaryContact}
                  onCheckedChange={(checked) => {
                    if (!checked || participant.isPrimary) return;
                    void change(() => addCrmDealParticipant(workspaceId, dealId, participant.contactId, {
                      role: participant.role,
                      isPrimary: true,
                    }));
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
