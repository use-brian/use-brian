"use client";

import { useCallback, useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { BarChart3, CircleDollarSign, Gauge, Target, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchCrmReport, type CrmReport } from "@/lib/api/crm";
import { formatCurrencyTotals } from "@/lib/crm-r2";
import { useT } from "@/lib/i18n/client";

export function CrmReportingDialog({
  workspaceId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT().crmPage.r2;
  const [report, setReport] = useState<CrmReport | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(async () => {
    setReport(null);
    setFailed(false);
    try {
      setReport(await fetchCrmReport(workspaceId));
    } catch {
      setFailed(true);
    }
  }, [workspaceId]);
  useEffect(() => {
    if (!open) return;
    void reload();
  }, [open, reload]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100%-2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div>
              <Dialog.Title className="flex items-center gap-2 text-base font-semibold">
                <BarChart3 className="size-4" aria-hidden /> {t.reportsTitle}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-muted-foreground">
                {t.reportsDescription}
              </Dialog.Description>
            </div>
            <Button size="icon-sm" variant="ghost" onClick={() => onOpenChange(false)} aria-label={t.close}>
              <X aria-hidden />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {failed ? (
              <div className="flex items-center justify-between gap-3 text-sm text-destructive"><span>{t.reportsFailed}</span><Button size="sm" variant="outline" onClick={() => void reload()}>{t.retry}</Button></div>
            ) : !report ? (
              <div className="text-sm text-muted-foreground">{t.reportsLoading}</div>
            ) : (
              <div className="space-y-6">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Metric icon={<CircleDollarSign />} label={t.openValue} value={formatCurrencyTotals(report.openValue) || t.noValue} />
                  <Metric icon={<Gauge />} label={t.weightedForecast} value={formatCurrencyTotals(report.weightedForecast) || t.noValue} />
                  <Metric icon={<Target />} label={t.winRate} value={report.winRate == null ? t.notEnoughHistory : `${report.winRate}%`} />
                  <Metric icon={<BarChart3 />} label={t.closedDeals} value={`${report.wonCount} / ${report.lostCount}`} hint={t.wonLost} />
                </div>

                <section>
                  <h3 className="mb-2 text-sm font-semibold">{t.pipelineBreakdown}</h3>
                  <div className="overflow-hidden rounded-xl border border-border">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-muted/50 text-muted-foreground">
                        <tr><th className="px-3 py-2">{t.stageColumn}</th><th className="px-3 py-2">{t.countColumn}</th><th className="px-3 py-2">{t.valueColumn}</th><th className="px-3 py-2">{t.velocityColumn}</th></tr>
                      </thead>
                      <tbody>
                        {report.byStage.map((stage) => {
                          const velocity = report.stageVelocityDays.find((row) => row.stageId === stage.stageId);
                          return (
                            <tr key={stage.stageId} className="border-t border-border/60">
                              <td className="px-3 py-2 font-medium">{stage.name}</td>
                              <td className="px-3 py-2 tabular-nums">{stage.count}</td>
                              <td className="px-3 py-2">{formatCurrencyTotals(stage.values) || t.noValue}</td>
                              <td className="px-3 py-2 text-muted-foreground">
                                {velocity?.medianDays == null
                                  ? t.notEnoughHistory
                                  : `${velocity.medianDays} ${t.days} (${velocity.samples})`}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>

                <div className="grid gap-4 lg:grid-cols-2">
                  <section className="rounded-xl border border-border p-4">
                    <h3 className="mb-3 text-sm font-semibold">{t.sourcePerformance}</h3>
                    {report.bySource.map((source) => (
                      <div key={source.source} className="flex items-center justify-between gap-3 border-t border-border/50 py-2 first:border-0">
                        <span className="text-xs">{source.source}</span>
                        <span className="text-right text-xs text-muted-foreground">
                          {source.count} · {source.won} {t.wonLower} · {formatCurrencyTotals(source.values)}
                        </span>
                      </div>
                    ))}
                  </section>
                  <section className="rounded-xl border border-border p-4">
                    <h3 className="mb-3 text-sm font-semibold">{t.dataCoverage}</h3>
                    <div className="space-y-2 text-xs">
                      <Coverage label={t.missingOwner} value={report.missingOwnerCount} />
                      <Coverage label={t.missingAmount} value={report.missingAmountCount} />
                    </div>
                  </section>
                </div>
              </div>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Metric({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-muted/20 p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</div>
      <div className="mt-2 text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Coverage({ label, value }: { label: string; value: number }) {
  return <div className="flex items-center justify-between"><span className="text-muted-foreground">{label}</span><span className="font-medium tabular-nums">{value}</span></div>;
}
