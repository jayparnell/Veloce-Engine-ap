import { useState } from "react";
import {
  useGetAutopilotUsage, getGetAutopilotUsageQueryKey,
  type AIUsageMetrics, type AIUsageEntry, type AIUsageGroup,
} from "@workspace/api-client-react";
import { ArrowUpRight, ChevronLeft, ChevronRight, Gauge } from "lucide-react";
import { cn } from "@/lib/utils";
import { Pill, Sk, btn, errMsg } from "./kit";

const CAT_LABEL: Record<string, string> = { source: "Source analysis", narration: "Narration", es: "Dub ES", pt: "Dub PT" };
const CAT_ORDER = ["source", "narration", "es", "pt"];
const STATUS: Record<string, { tone: "emerald" | "amber" | "red" | "neutral" | "sky"; label: string; hint: string }> = {
  started: { tone: "neutral", label: "historical", hint: "Legacy reporting entry; never blocks processing." },
  done: { tone: "emerald", label: "done", hint: "Completed and recorded." },
  uncertain: { tone: "neutral", label: "historical", hint: "Legacy reporting entry; never blocks processing." },
  failed: { tone: "red", label: "failed", hint: "Call failed. See the job card for the OpenAI diagnostic." },
  rejected: { tone: "neutral", label: "rejected", hint: "Provider definitively rejected the request. 0 internal request units; this is not a credit statement." },
};

const n = (v: number | null) => (v == null ? "unknown" : v.toLocaleString());
const secs = (v: number | null) => (v == null ? "unknown" : `${v.toFixed(1)}s`);

function Metrics({ m, compact }: { m: AIUsageMetrics; compact?: boolean }) {
  const audio = m.inputAudioTokens != null || m.outputAudioTokens != null;
  return (
    <span className={cn("mono tabular-nums", compact ? "text-[10.5px]" : "text-[11px]")}>
      <span className={m.totalTokens == null ? "text-zinc-600 italic" : "text-zinc-300"}>{n(m.totalTokens)} tok</span>
      <span className="text-zinc-500"> (in {n(m.inputTokens)} / out {n(m.outputTokens)})</span>
      {audio && <span className="text-zinc-500"> · of which audio in {n(m.inputAudioTokens)} / out {n(m.outputAudioTokens)}</span>}
      {m.audioSeconds != null && <span className="text-zinc-500"> · {secs(m.audioSeconds)} audio</span>}
    </span>
  );
}

function Meter({ label, used, limit, testId }: { label: string; used: number; limit: number | null; testId: string }) {
  const pct = limit == null ? 0 : limit === 0 ? 1 : Math.min(1, used / limit);
  const tone = limit != null && used >= limit ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="min-w-0" data-testid={testId}>
      <div className="flex justify-between mono text-[10.5px] mb-1 gap-2">
        <span className="text-zinc-500 uppercase tracking-wider truncate">{label}</span>
        <span className="tabular-nums text-zinc-300">{used}{limit != null ? ` / ${limit}` : " / no cap"}</span>
      </div>
      <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
        <div className={cn("h-full origin-left transition-transform duration-700", tone)} style={{ transform: `scaleX(${pct})` }} />
      </div>
    </div>
  );
}


export function AIUsagePanel() {
  const [cursors, setCursors] = useState<number[]>([]);
  const before = cursors[cursors.length - 1];
  const params = before ? { before } : undefined;
  const usage = useGetAutopilotUsage(params, { query: {
    queryKey: getGetAutopilotUsageQueryKey(params), refetchInterval: 5000, refetchIntervalInBackground: false, refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  } });

  const d = usage.data;
  if (!d) return usage.isError
    ? <div className="panel px-4 py-3 my-4 text-[12px] text-zinc-400" data-testid="ai-usage-error">AI usage unavailable: {errMsg(usage.error)} <button className="underline" onClick={() => usage.refetch()} data-testid="button-retry-ai-usage">Try again</button></div>
    : <Sk className="h-48 my-4" />;

  const groups = CAT_ORDER.map((c) => d.groups.find((g) => g.category === c)).filter(Boolean) as AIUsageGroup[];

  const bySource = new Map<number, { title: string; projectId: number; rows: AIUsageEntry[] }>();
  for (const e of d.entries) {
    const s = bySource.get(e.jobId) ?? { title: e.sourceTitle, projectId: e.projectId, rows: [] };
    s.rows.push(e); bySource.set(e.jobId, s);
  }

  return (
    <section className="panel my-4 overflow-hidden text-[12px] rise" data-testid="ai-usage">
      <div className="px-4 py-3 border-b border-white/[0.05] flex flex-wrap items-center gap-2">
        <Gauge className="w-3.5 h-3.5 text-emerald-400" />
        <h2 className="text-[13.5px] font-semibold">AI usage</h2>
        <Pill tone="neutral">owner only</Pill>
        <span className="mono text-[10.5px] text-zinc-500">passive reporting · rolling 24h</span>
        {usage.isFetching && <span className="mono text-[10.5px] text-zinc-600 ml-auto">syncing</span>}
      </div>

      <div className="px-4 py-3 grid gap-3 sm:grid-cols-3 border-b border-white/[0.05]">
        <Meter label="Request units" used={d.usedUnits} limit={d.dailyRequestUnitLimit} testId="meter-units" />
        <Meter label="Active jobs" used={d.activeJobs} limit={d.activeJobLimit} testId="meter-active-jobs" />
        <Meter label="Jobs / 24h" used={d.dailyJobs} limit={d.dailyJobLimit} testId="meter-daily-jobs" />
        <p className="sm:col-span-3 mono text-[10.5px] text-zinc-500" data-testid="text-ai-remaining">
          {d.remainingUnits == null ? "No additional unit cap" : `${d.remainingUnits} units remaining`} · {d.remainingActiveJobs} active slots · {d.remainingDailyJobs} job admissions left (durable admissions)
        </p>
      </div>


      <div className="grid grid-cols-2 lg:grid-cols-4 border-b border-white/[0.05]">
        {groups.map((g) => (
          <div key={g.category} className="px-4 py-3 border-r border-b lg:border-b-0 border-white/[0.05] last:border-r-0 min-w-0" data-testid={`group-${g.category}`}>
            <div className="label-xs">{CAT_LABEL[g.category]}</div>
            <div className="mono text-[18px] tabular-nums mt-0.5">{g.units}<span className="text-[11px] text-zinc-500"> units</span></div>
            <div className="mt-1"><Metrics m={g.metrics} compact /></div>
            <div className="mt-1 flex flex-wrap gap-1">
              {g.unknown > 0 && <Pill tone="neutral">{g.unknown} unreported</Pill>}
            </div>
            {g.unknown > 0 && <p className="text-[10.5px] text-zinc-500 mt-1">Known subtotal only; full usage is unknown.</p>}
          </div>
        ))}
      </div>

      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <span className="label-xs">Call history {cursors.length > 0 && `· page ${cursors.length + 1}`}</span>
          <div className="flex gap-1">
            <button className={btn.ghost} disabled={!cursors.length} onClick={() => setCursors((c) => c.slice(0, -1))} data-testid="button-usage-newer"><ChevronLeft className="w-3.5 h-3.5" />Newer</button>
            <button className={btn.ghost} disabled={d.nextBefore == null || usage.isPlaceholderData} onClick={() => d.nextBefore != null && setCursors((c) => [...c, d.nextBefore!])} data-testid="button-usage-older">Older<ChevronRight className="w-3.5 h-3.5" /></button>
          </div>
        </div>
        {!bySource.size ? <p className="text-zinc-500 mono text-[11px] py-2" data-testid="text-usage-empty">No AI calls recorded on this page.</p> : (
          <div className="space-y-2.5 max-h-[420px] overflow-y-auto pr-1">
            {[...bySource.entries()].map(([jobId, s]) => (
              <div key={jobId} className="rounded-md border border-white/[0.06] bg-[#0B0B0D]" data-testid={`usage-job-${jobId}`}>
                <div className="px-3 py-1.5 border-b border-white/[0.05] flex items-center gap-2 min-w-0">
                  <span className="mono text-[10.5px] text-zinc-500 shrink-0">JOB {jobId}</span>
                  <span className="truncate font-medium">{s.title}</span>
                  <span className="ml-auto mono text-[10.5px] text-zinc-500 shrink-0">{s.rows.reduce((a, r) => a + r.units, 0)} units</span>
                </div>
                <ul>
                  {s.rows.map((e) => {
                    const st = STATUS[e.status] ?? STATUS.started;
                    return (
                      <li key={e.id} className="px-3 py-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-white/[0.03] last:border-0" title={st.hint} data-testid={`row-usage-${e.id}`}>
                        <Pill tone={e.category === "es" || e.category === "pt" ? "sky" : "neutral"}>{CAT_LABEL[e.category]}</Pill>
                        <Pill tone={st.tone} dot={e.status === "started"}>{st.label}</Pill>
                        <span className="mono text-[10.5px] text-zinc-500 truncate max-w-[180px]">{e.callKey}</span>
                        <span className="mono text-[10.5px] text-zinc-400">{e.units}u</span>
                        <Metrics m={e.metrics} compact />
                        <span className="mono text-[10.5px] text-zinc-600 ml-auto">{e.model ?? "model unknown"} · {new Date(e.createdAt).toLocaleString()}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-white/[0.06] bg-white/[0.012] px-4 py-3 space-y-1.5 text-[11.5px] text-zinc-400 leading-relaxed" data-testid="text-ai-disclaimer">
        {d.notice && <p>{d.notice}</p>}
        <p>Request units count new durable AI checkpoint attempts. Saved-result reuse adds nothing; automatic retries are new attempts and earlier history stays. Direct OpenAI calls use your key when configured; otherwise managed AI is used. Ambiguous retries can incur additional charges. Units are not tokens, credits or currency, and the cap is not an exact spending cap. Token counts are provider-reported only; unknown never means zero. Audio tokens are part of the total.</p>
        <a href="https://docs.replit.com/billing/ai-billing" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300" data-testid="link-replit-ai-billing">Official Replit AI billing <ArrowUpRight className="w-3 h-3" /></a>
      </div>
    </section>
  );
}
