"use client";
import { useEffect, useState } from "react";
import { DEFAULT_INTERACTION_RULE, interactionRequest } from "@/lib/live-interaction/api";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";

export function LiveInteractionSettings() {
  const t = useT().liveInteraction;
  const [rule, setRule] = useState(DEFAULT_INTERACTION_RULE);
  const [text, setText] = useState("");
  const [available, setAvailable] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void interactionRequest<{ rule: string; available: boolean }>("/settings").then((value) => {
      if (!cancelled) { setRule(value.rule); setAvailable(value.available); setReady(true); }
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, []);
  const run = async (preview: boolean) => {
    setBusy(true); setError(false); setSaved(false);
    try {
      if (preview) {
        const value = await interactionRequest<{ question: string | null }>("/preview", { rule, text });
        setResult(value.question ?? t.noMatch);
      } else {
        await interactionRequest("/settings", { rule }, "PUT"); setSaved(true);
      }
    } catch { setError(true); } finally { setBusy(false); }
  };
  return <section className="space-y-3 rounded-xl border p-4">
    <h3 className="font-medium">{t.personal}</h3>
    <p className="text-sm text-muted-foreground">{t.description}</p>
    {ready && !available && <p role="status" className="text-sm">{t.unavailable}</p>}
    <label className="block space-y-1 text-sm">{t.rule}<textarea className="w-full rounded-md border bg-background p-2 text-base" rows={3} maxLength={4000} value={rule} disabled={!ready || busy} onChange={(event) => { setRule(event.target.value); setSaved(false); setResult(null); }} /></label>
    <div className="flex flex-wrap gap-2">
      <Button className="min-h-11" disabled={!ready || busy || !rule.trim()} onClick={() => void run(false)}>{t.save}</Button>
      <Button className="min-h-11" variant="outline" disabled={busy} onClick={() => { setRule(DEFAULT_INTERACTION_RULE); setSaved(false); }}>{t.defaultRule}</Button>
    </div>
    <label className="block space-y-1 text-sm">{t.sample}<textarea className="w-full rounded-md border bg-background p-2 text-base" rows={2} value={text} onChange={(event) => { setText(event.target.value); setResult(null); }} /></label>
    <Button className="min-h-11" variant="outline" disabled={!available || busy || !text.trim() || !rule.trim()} onClick={() => void run(true)}>{t.preview}</Button>
    {result !== null && <p role="status" className="text-sm whitespace-pre-wrap">{result}</p>}
    {saved && <p role="status" className="text-sm">{t.saved}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{t.error}</p>}
  </section>;
}
