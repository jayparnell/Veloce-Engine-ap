import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetStorageReport, getGetStorageReportQueryKey, useListStorageCleanups, getListStorageCleanupsQueryKey,
  usePreviewStorageCleanup, useConfirmStorageCleanup, type StorageReport, type StorageObject,
} from "@workspace/api-client-react";
import { HardDrive, RefreshCw, ShieldCheck, AlertTriangle, ScanSearch, History } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Pill, Sk, ErrorState, statusTone, errMsg, btn, field } from "@/components/kit";

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"]; let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
}
const fmtTime = (s: string) => new Date(s).toLocaleString();
const CATS: { key: string; label: string }[] = [
  { key: "uploads", label: "Uploads" }, { key: "intermediates", label: "Recovery intermediates" },
  { key: "final", label: "Final clips" }, { key: "exports", label: "Export packs" },
];
const matchCat = (c: string, key: string) => c.toLowerCase().includes(key.replace(/s$/, ""));

function parseDays(v: string): { val: number | null; ok: boolean } {
  if (v.trim() === "") return { val: null, ok: true };
  const n = Number(v);
  return { val: n, ok: Number.isInteger(n) && n >= 7 && n <= 3650 };
}

function ObjectRows({ objects, showOutcome }: { objects: StorageObject[]; showOutcome?: boolean }) {
  return (
    <div className="max-h-[300px] overflow-y-auto rounded-md border border-white/[0.06] divide-y divide-white/[0.05]">
      {objects.map((o, i) => (
        <div key={o.objectPath + i} className="px-3 py-2 text-[11.5px] grid sm:grid-cols-[1fr_auto] gap-1" data-testid={`row-storage-object-${i}`}>
          <div className="min-w-0">
            <div className="mono text-[11px] break-all text-zinc-200">{o.objectPath}</div>
            <div className="text-zinc-500">{o.category} · created {fmtTime(o.createdAt)} · gen {o.generation} · {o.reason}</div>
          </div>
          <div className="flex items-center gap-1.5 sm:justify-end">
            <span className="mono tabular-nums text-zinc-300">{fmtBytes(o.bytes)}</span>
            {showOutcome ? <Pill tone={statusTone(o.outcome)}>{o.outcome || "pending"}</Pill> : <Pill tone={o.eligible ? "amber" : "emerald"}>{o.eligible ? "eligible" : "protected"}</Pill>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function StorageManager() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const report = useGetStorageReport({ query: { queryKey: getGetStorageReportQueryKey() } });
  const history = useListStorageCleanups({ query: { queryKey: getListStorageCleanupsQueryKey() } });
  const [exp, setExp] = useState("");
  const [inter, setInter] = useState("");
  const [preview, setPreview] = useState<StorageReport | null>(null);
  const [phrase, setPhrase] = useState("");
  const [result, setResult] = useState<StorageReport | null>(null);
  const [showInv, setShowInv] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!preview) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [preview]);

  const e = parseDays(exp), it = parseDays(inter);
  const discard = () => { setPreview(null); setPhrase(""); };
  const refresh = () => { qc.invalidateQueries({ queryKey: getGetStorageReportQueryKey() }); qc.invalidateQueries({ queryKey: getListStorageCleanupsQueryKey() }); };

  const prev = usePreviewStorageCleanup({ mutation: {
    onSuccess: (r) => { setPreview(r); setPhrase(""); setResult(null); },
    onError: (err) => toast({ title: "Dry run failed", description: errMsg(err), variant: "destructive" }),
  } });
  const conf = useConfirmStorageCleanup({ mutation: {
    onSuccess: (r) => { setResult(r); setPreview(null); setPhrase(""); refresh(); toast({ title: "Cleanup finished", description: `Status: ${r.status}. Review per-object results below.` }); },
    onError: (err) => { setPreview(null); setPhrase(""); refresh(); toast({ title: "Cleanup not completed", description: `${errMsg(err)} Run a new dry run to review the current state.`, variant: "destructive" }); },
  } });

  const eligible = preview?.objects.filter((o) => o.eligible) ?? [];
  const eligibleBytes = eligible.reduce((s, o) => s + o.bytes, 0);
  const expected = `DELETE ${eligible.length} OBJECTS`;
  const expired = !!preview && new Date(preview.expiresAt).getTime() <= now;
  const r = report.data;
  const protectedObjs = r?.objects.filter((o) => !o.eligible) ?? [];

  return (
    <section className="panel mt-6 rise" data-testid="section-storage">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
        <HardDrive className="w-4 h-4 text-emerald-400" />
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] font-medium">Storage</div>
          <div className="text-[11px] text-zinc-500">Nothing is deleted automatically. Cleanup only runs when you confirm a reviewed dry run.</div>
        </div>
        <button className={btn.ghost} onClick={() => { report.refetch(); history.refetch(); }} disabled={report.isFetching} data-testid="button-refresh-storage">
          <RefreshCw className={cn("w-3.5 h-3.5", report.isFetching && "animate-spin")} /> Refresh
        </button>
      </div>

      <div className="p-4 md:p-5 space-y-5">
        <div className="flex gap-2 p-3 rounded-md border border-sky-500/20 bg-sky-500/[0.05] text-[11.5px] text-sky-200" data-testid="text-storage-notice">
          <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5" />
          <div>Inventory includes owner-verified private objects only; unverified legacy assets are kept. Unknown objects are protected, intermediates are frozen while any job is active or retryable, and every MP4 and every referenced object is always protected.{r?.notice && <div className="text-sky-300/80 mt-1">{r.notice}</div>}</div>
        </div>

        {report.isLoading ? <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{[0, 1, 2, 3].map((i) => <Sk key={i} className="h-20" />)}</div>
          : report.isError ? <ErrorState title="Could not load storage report" error={report.error} onRetry={() => report.refetch()} />
          : r && (<>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {CATS.map((c) => {
                const t = r.totals.filter((x) => matchCat(x.category, c.key));
                const bytes = t.reduce((s, x) => s + x.bytes, 0), count = t.reduce((s, x) => s + x.count, 0);
                return (
                  <div key={c.key} className="p-3 rounded-lg bg-[#09090B] border border-white/[0.06]" data-testid={`stat-storage-${c.key}`}>
                    <div className="label-xs">{c.label}</div>
                    <div className="mono text-[18px] tabular-nums mt-1">{fmtBytes(bytes)}</div>
                    <div className="text-[11px] text-zinc-500">{count} object{count === 1 ? "" : "s"}</div>
                  </div>
                );
              })}
            </div>
            {r.totals.some((x) => !CATS.some((c) => matchCat(x.category, c.key))) && (
              <div className="text-[11px] text-zinc-500 mono">Other: {r.totals.filter((x) => !CATS.some((c) => matchCat(x.category, c.key))).map((x) => `${x.category} ${fmtBytes(x.bytes)} (${x.count})`).join(" · ")}</div>
            )}
            <div>
              <button className="text-[11.5px] text-zinc-400 hover:text-zinc-200 underline" onClick={() => setShowInv(!showInv)} data-testid="button-toggle-inventory">
                {showInv ? "Hide" : "Show"} inventory protection reasons ({protectedObjs.length} protected)
              </button>
              {showInv && <div className="mt-2">{r.objects.length ? <ObjectRows objects={r.objects} /> : <div className="text-[12px] text-zinc-500">No verified objects in inventory.</div>}</div>}
            </div>
          </>)}

        <div className="rounded-lg border border-white/[0.06] p-4 space-y-3">
          <div className="label-xs">One-time retention dry run</div>
          <div className="grid sm:grid-cols-2 gap-3">
            {[{ l: "Export packs older than (days)", v: exp, s: setExp, ok: e.ok, id: "export" }, { l: "Recovery intermediates older than (days)", v: inter, s: setInter, ok: it.ok, id: "intermediate" }].map((f) => (
              <div key={f.id}>
                <label className="text-[11.5px] text-zinc-400">{f.l}</label>
                <input inputMode="numeric" value={f.v} disabled={prev.isPending || conf.isPending} placeholder="Keep everything" onChange={(ev) => { f.s(ev.target.value); discard(); }} className={cn(field, "mt-1 mono", !f.ok && "border-red-500/60")} data-testid={`input-retention-${f.id}`} />
                {!f.ok && <div className="text-[10.5px] text-red-400 mt-1">Whole number from 7 to 3650, or blank.</div>}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className={btn.primary} disabled={!e.ok || !it.ok || prev.isPending || conf.isPending} onClick={() => { discard(); prev.mutate({ data: { exportDays: e.val, intermediateDays: it.val } }); }} data-testid="button-preview-cleanup">
              <ScanSearch className="w-3.5 h-3.5" /> {prev.isPending ? "Scanning..." : "Run dry run"}
            </button>
            <span className="text-[11px] text-zinc-500">Final clips and uploads are never candidates. Blank keeps everything.</span>
          </div>

          {preview && (
            <div className="space-y-3 pt-2" data-testid="section-cleanup-preview">
              <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                <Pill tone={eligible.length ? "amber" : "emerald"}>{eligible.length} eligible</Pill>
                <span className="mono text-zinc-300">{fmtBytes(eligibleBytes)}</span>
                <span className="text-zinc-500">· {preview.objects.length - eligible.length} protected · report {preview.reportId.slice(0, 8)} · expires {fmtTime(preview.expiresAt)}</span>
                {expired && <Pill tone="red">expired, run again</Pill>}
              </div>
              {eligible.length === 0 ? <div className="text-[12px] text-zinc-400">Nothing qualifies under these cutoffs. No confirmation needed.</div> : (<>
                <ObjectRows objects={eligible} />
                <div className="flex gap-2 p-3 rounded-md border border-red-500/30 bg-red-500/[0.06] text-[11.5px] text-red-200">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>Irreversible. Only these exact {eligible.length} objects (matching generation) will be deleted. No final clips or uploads are included. Anything that changed since the dry run is skipped.</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input value={phrase} onChange={(ev) => setPhrase(ev.target.value)} placeholder={expected} className={cn(field, "mono max-w-[280px]")} data-testid="input-confirm-phrase" />
                  <button className={btn.danger} disabled={phrase !== expected || expired || conf.isPending}
                    onClick={() => conf.mutate({ data: { reportId: preview.reportId, objectPaths: eligible.map((o) => o.objectPath), confirmation: phrase } })} data-testid="button-confirm-cleanup">
                    {conf.isPending ? "Deleting..." : `Delete ${eligible.length} objects`}
                  </button>
                  <span className="text-[11px] text-zinc-500">Type <span className="mono text-zinc-300">{expected}</span></span>
                </div>
              </>)}
            </div>
          )}

          {result && (
            <div className="space-y-2 pt-2" data-testid="section-cleanup-result">
              <div className="flex items-center gap-2 text-[11.5px]"><Pill tone={statusTone(result.status)}>{result.status}</Pill><span className="text-zinc-500">Per-object results</span></div>
              <ObjectRows objects={result.objects} showOutcome />
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center gap-1.5 label-xs mb-2"><History className="w-3 h-3" /> Cleanup audit history</div>
          {history.isLoading ? <Sk className="h-16" /> : history.isError ? <ErrorState title="Could not load history" error={history.error} onRetry={() => history.refetch()} />
            : !history.data?.length ? <div className="text-[12px] text-zinc-500">No cleanups have been confirmed yet.</div>
            : <div className="space-y-2">{history.data.map((h) => {
                const counts = h.objects.reduce<Record<string, number>>((m, o) => { const k = o.outcome || "pending"; m[k] = (m[k] ?? 0) + 1; return m; }, {});
                return (
                  <details key={h.reportId} className="rounded-md border border-white/[0.06] px-3 py-2" data-testid={`row-cleanup-${h.reportId}`}>
                    <summary className="cursor-pointer flex flex-wrap items-center gap-2 text-[11.5px]">
                      <Pill tone={statusTone(h.status)}>{h.status}</Pill>
                      <span className="mono text-zinc-400">{fmtTime(h.createdAt)}</span>
                      <span className="text-zinc-500">{Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(" · ") || "no objects"}</span>
                    </summary>
                    <div className="mt-2">{h.objects.length ? <ObjectRows objects={h.objects} showOutcome /> : null}</div>
                  </details>
                );
              })}</div>}
        </div>
      </div>
    </section>
  );
}
