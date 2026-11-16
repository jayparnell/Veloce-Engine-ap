import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCreateExport, useCloneAndDub, getGetAutopilotSwarmQueryKey, getListClipsQueryKey, type ExportResult,
  useGetRenderBudget, getGetRenderBudgetQueryKey, useUpdateRenderBudget } from "@workspace/api-client-react";
import { Download, Languages } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Pill, btn, errMsg, field } from "./kit";

export function RenderBudgetSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const budget = useGetRenderBudget({ query: { refetchInterval: 10000, refetchOnWindowFocus: true } });
  const [cap, setCap] = useState("");
  useEffect(() => { if (budget.data) setCap(String(budget.data.dailyRenderCap)); }, [budget.data?.dailyRenderCap]);
  const save = useUpdateRenderBudget({ mutation: {
    onSuccess: (data) => {
      qc.setQueryData(getGetRenderBudgetQueryKey(), data);
      qc.invalidateQueries({ queryKey: getGetRenderBudgetQueryKey() });
      qc.invalidateQueries({ queryKey: getGetAutopilotSwarmQueryKey() });
      toast({ title: "Daily Render Cap saved", description: "Budget-paused work will be checked again. Existing job safety quotas are unchanged." });
    },
    onError: (error) => toast({ title: "Cap was not changed", description: errMsg(error), variant: "destructive" }),
  } });
  const data = budget.data;
  if (!data) return <div className="text-[12px] text-zinc-400 py-3">{budget.isError
    ? <>Render budget unavailable: {errMsg(budget.error)} <button className="underline" onClick={() => budget.refetch()}>Try again</button></>
    : "Loading daily render budget…"}</div>;
  return <div className="panel px-4 py-3 my-4 space-y-2 text-[12px]" data-testid="render-budget">
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor="daily-render-cap" className="font-medium">Daily Render Cap</label>
      <input id="daily-render-cap" type="number" min={0} max={1000} step={1} value={cap} onChange={(e) => setCap(e.target.value)}
        className={cn(field, "w-20 h-8")} data-testid="input-daily-render-cap" />
      <span className="text-zinc-500">clips/day</span>
      <button className={btn.ghost} disabled={save.isPending || !/^\d+$/.test(cap) || Number(cap) > 1000 || Number(cap) === data.dailyRenderCap}
        onClick={() => save.mutate({ data: { dailyRenderCap: Number(cap) } })} data-testid="button-save-render-cap">{save.isPending ? "Saving…" : "Save cap"}</button>
      <span className="mono text-zinc-300" data-testid="text-render-counters">{data.completed} completed · {data.reserved} reserved · {data.remaining} remaining</span>
      {data.pausedJobs > 0 && <Pill tone="amber">{data.pausedJobs} budget-paused</Pill>}
    </div>
    <p className="text-zinc-400">Resets at midnight {data.resetTimezone} ({new Date(data.resetAt).toLocaleString()} your time). Unfinished reservations carry over. Insufficient allowance pauses work before paid AI; it resumes after reset while the worker runs.</p>
    <p className="text-zinc-500">Each original or language variant counts as one output. Sources reserve up to 5 clips before analysis and release unused slots. A clip cap is not an exact monetary or AI-credit cap; failed work can still incur usage. Separate 10-active / 20-daily job safety quotas still apply.</p>
  </div>;
}

export function FailureDetails({ status, kind, count = 0, retryAt }: { status: string; kind?: string | null; count?: number; retryAt?: string | null }) {
  if (!kind && !count && !retryAt) return null;
  const actions: Record<string, string> = {
    uncertain_ai: "Review possible AI usage before acknowledging any repeat. Saved results are reused.",
    uncertain_publish: "Reconcile the saved provider identifiers and recent posts before any repeat. No blind repost.",
    consent_required: "Review this video and the provider consent requirements.",
    access_blocked: "Reconnect or resolve account access before resuming.",
    permanent: "Correct source, media, validation or account restrictions before requesting another attempt.",
    daily_cap: "Waiting for clip allowance. Raise the cap or wait for midnight EST (fixed UTC-05:00).",
    ai_usage_cap: "Waiting for rolling 24-hour AI request allowance. Increase the AI request-unit cap or wait for usage to expire; saved results are reused.",
    retry_exhausted: "Automatic retries stopped after two failed attempts. Saved clips and checkpoints are preserved.",
    rate_limited: status === "failed" ? "Automatic retry exhausted. Honor the provider restriction before any explicit repeat." : "Provider rate limit: the retry will honor Retry-After.",
    transient: "Saved results will be reused; other queued work continues.",
  };
  return <p className="mt-2 text-[11.5px] text-amber-200/80" data-testid="failure-details">
    {count > 0 && `${count} failed attempt${count === 1 ? "" : "s"}. `}
    {status === "retry" && `One automatic retry eligible after ${retryAt ? new Date(retryAt).toLocaleString() : "60 seconds"}. `}
    {status !== "retry" && retryAt && `Not before ${new Date(retryAt).toLocaleString()}. `}
    {kind ? actions[kind] : ""}
  </p>;
}

export const PACK_LABEL = "Download Ready-to-Post Pack (.zip)";
export const DUB_LABEL = "Clone & Dub (ES / PT)";

/** Builds the pack server-side, then shows a direct link (Safari blocks async popups). */
export function usePack() {
  const { toast } = useToast();
  const [res, setRes] = useState<ExportResult | null>(null);
  const exp = useCreateExport({ mutation: { onSuccess: (r) => setRes(r), onError: (e) => toast({ title: "Pack could not be built", description: errMsg(e), variant: "destructive" }) } });
  const dialog = (
    <Dialog open={!!res} onOpenChange={(o) => !o && setRes(null)}>
      <DialogContent className="bg-[#121215] border-white/[0.08] max-w-[calc(100vw-24px)] sm:max-w-md">
        <DialogTitle className="text-[15px]">Ready-to-Post Pack built</DialogTitle>
        <DialogDescription className="text-[12.5px]">{res?.message}</DialogDescription>
        <div className="flex items-center gap-2 p-3 rounded-md bg-[#09090B] border border-white/[0.06] min-w-0">
          <Download className="w-4 h-4 text-emerald-400 shrink-0" /><span className="mono text-[12px] truncate flex-1" data-testid="text-pack-filename">{res?.filename}</span>
          <Pill tone={res?.includesVideo ? "emerald" : "amber"}>{res?.includesVideo ? "Video included" : "Metadata only"}</Pill>
        </div>
        <div className="flex justify-end gap-2"><button className={btn.ghost} onClick={() => setRes(null)}>Close</button>
          <a href={res?.downloadUrl} download={res?.filename} className={btn.primary} data-testid="link-download-pack">Save .zip</a></div>
      </DialogContent>
    </Dialog>
  );
  return { start: (clipIds: number[]) => exp.mutate({ data: { clipIds } }), pending: exp.isPending, dialog };
}

export function useDub() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const m = useCloneAndDub({ mutation: {
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: getGetAutopilotSwarmQueryKey() });
      qc.invalidateQueries({ queryKey: getListClipsQueryKey() });
      toast({ title: "Dub variants requested", description: `${r.jobIds.length} new or existing variant job${r.jobIds.length === 1 ? "" : "s"} returned. Completed variants are reused; originals stay playable.` });
    },
    onError: (e) => toast({ title: "Could not queue dubs", description: errMsg(e), variant: "destructive" }),
  } });
  return { start: (clipIds: number[]) => m.mutate({ data: { clipIds } }), pending: m.isPending };
}

export function PackButton({ onClick, pending, disabled, className, testId }: { onClick: () => void; pending: boolean; disabled?: boolean; className?: string; testId: string }) {
  return <button className={cn(btn.primary, className)} disabled={pending || disabled} onClick={onClick} data-testid={testId}><Download className="w-3.5 h-3.5" />{pending ? "Building pack..." : PACK_LABEL}</button>;
}

export function DubButton({ onClick, pending, disabled, className, testId, children }: { onClick: () => void; pending: boolean; disabled?: boolean; className?: string; testId: string; children?: ReactNode }) {
  return <button className={cn(btn.ghost, className)} disabled={pending || disabled} onClick={onClick} data-testid={testId}><Languages className="w-3.5 h-3.5" />{pending ? "Queuing..." : children ?? DUB_LABEL}</button>;
}

export const isUncertain = (s: string) => /uncertain/i.test(s);
