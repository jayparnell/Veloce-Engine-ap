import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@workspace/replit-auth-web";
import {
  useLaunchAutopilot, useGetAutopilotSwarm, getGetAutopilotSwarmQueryKey, useControlAutopilotJob,
  getListClipsQueryKey, getGetStudioSummaryQueryKey, getGetAutopilotScheduleQueryKey, type SwarmJob, type SwarmClip, type JobActionAction,
} from "@workspace/api-client-react";
import { Rocket, Upload, ShieldCheck, Radio, RotateCw, Ban, AlertTriangle, ArrowUpRight, Lock, Film } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useFileUpload } from "@/hooks/use-file-upload";
import { cn } from "@/lib/utils";
import { PageHeader, Pill, Sk, ErrorState, EmptyState, isActiveStatus, statusTone, errMsg } from "@/components/kit";
import { AIUsagePanel } from "@/components/ai-usage";
import { usePack, useDub, PackButton, DubButton, isUncertain, RenderBudgetSettings, FailureDetails } from "@/components/autopilot";

const MAX_SOURCES = 5;
const newKey = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}-launch`).replace(/[^a-zA-Z0-9-]/g, "");
const parseSources = (t: string) => t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const isCancelled = (s: string) => /cancel/i.test(s);
const isFailed = (s: string) => /fail|error/i.test(s);
const jobLive = (j: SwarmJob) => ["queued", "processing"].includes(j.status);

type Pending = { job: SwarmJob; action: JobActionAction } | null;

function ClipTile({ c, jobId, pack, dub }: { c: SwarmClip; jobId: number; pack: ReturnType<typeof usePack>; dub: ReturnType<typeof useDub> }) {
  const clip = c.clip;
  const ready = !!clip?.videoUrl && /ready|complete|done/i.test(c.status);
  return (
    <div className="rounded-lg border border-white/[0.07] bg-[#0B0B0D] overflow-hidden flex flex-col rise" data-testid={`tile-clip-${jobId}-${c.index}`}>
      <div className="relative aspect-[9/16] bg-[#050506]">
        {ready && clip ? (
          <video src={clip.videoUrl} poster={clip.thumbnail || undefined} controls playsInline preload="metadata" className="absolute inset-0 w-full h-full object-cover" data-testid={`video-clip-${clip.id}`} />
        ) : (
          <div className="absolute inset-0 grid-bg flex flex-col items-center justify-center gap-2 p-3 text-center">
            {isFailed(c.status) ? <AlertTriangle className="w-4 h-4 text-red-400" /> : <span className="w-8 h-1 rounded-full bg-emerald-500/25 relative overflow-hidden scan" />}
            <span className="mono text-[10px] uppercase tracking-wider text-zinc-500">{c.status}</span>
          </div>
        )}
        <div className="absolute top-1.5 left-1.5 flex gap-1 pointer-events-none">
          <Pill tone="neutral" className="bg-black/60">#{c.index + 1}</Pill>
          <Pill tone={c.language === "en" ? "neutral" : "sky"} className="bg-black/60">{c.language.toUpperCase()}</Pill>
        </div>
      </div>
      <div className="p-2 space-y-1.5 flex-1 flex flex-col">
        <div className="flex items-center gap-1.5 min-w-0"><Pill tone={statusTone(c.status)} dot={isActiveStatus(c.status) && !isFailed(c.status)}>{c.status}</Pill></div>
        {clip && <div className="text-[11.5px] leading-snug line-clamp-2">{clip.title}</div>}
        {ready && clip && <div className="mt-auto space-y-1 pt-1">
          <PackButton className="w-full h-auto min-h-8 py-1.5 text-[11px] leading-tight whitespace-normal" pending={pack.pending} onClick={() => pack.start([clip.id])} testId={`button-pack-${clip.id}`} />
          {!clip.originalClipId && <DubButton className="w-full h-8 text-[11px]" pending={dub.pending} onClick={() => dub.start([clip.id])} testId={`button-dub-${clip.id}`} />}
        </div>}
      </div>
    </div>
  );
}

function JobCard({ j, onAction, pack, dub }: { j: SwarmJob; onAction: (a: JobActionAction) => void; pack: ReturnType<typeof usePack>; dub: ReturnType<typeof useDub> }) {
  const live = jobLive(j);
  const readyIds = j.clips.filter((c) => c.clip?.videoUrl && /ready|complete|done/i.test(c.status) && !c.clip.originalClipId).map((c) => c.clip!.id);
  const uncertain = isUncertain(j.status) || j.failureKind === "uncertain_ai";
  return (
    <article className="panel overflow-hidden rise" data-testid={`card-job-${j.id}`}>
      <div className="px-4 pt-3.5 pb-3 border-b border-white/[0.05]">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="mono text-[11px] text-zinc-500">JOB {j.id}</span>
              <Pill tone={uncertain ? "amber" : statusTone(j.status)} dot={live}>{j.status}</Pill>
              <Pill tone="neutral">{j.language.toUpperCase()}</Pill>
            </div>
            <div className="text-[13.5px] font-medium mt-1 truncate" data-testid={`text-job-title-${j.id}`}>{j.title}</div>
            <div className="mono text-[11px] text-zinc-500 truncate">{j.sourceUrl}</div>
          </div>
          <span className="mono text-[11px] text-zinc-500 whitespace-nowrap hidden sm:block">{formatDistanceToNow(new Date(j.createdAt), { addSuffix: true })}</span>
        </div>
        <div className="mt-3">
          <div className="flex justify-between mono text-[10.5px] mb-1"><span className={live ? "text-emerald-400" : "text-zinc-500"}>{j.stage}</span><span className="tabular-nums text-zinc-400">{Math.round(j.progress)}%</span></div>
          <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden relative">
            <div className={cn("h-full rounded-full origin-left transition-transform duration-700", isFailed(j.status) ? "bg-red-500/70" : "bg-emerald-500")} style={{ transform: `scaleX(${Math.max(0, Math.min(100, j.progress)) / 100})` }} />
          </div>
        </div>
        {j.notice && <p className="mt-2 text-[11.5px] text-zinc-400 leading-relaxed" data-testid={`text-job-notice-${j.id}`}>{j.notice}</p>}
        {j.error && <div className="mt-2 text-[12px] text-red-300 bg-red-500/5 border border-red-500/15 rounded-md px-2.5 py-1.5 break-words" data-testid={`text-job-error-${j.id}`}>{j.error}</div>}
        <FailureDetails status={j.status} kind={j.failureKind} count={j.failures} retryAt={j.retryAt} />
        <div className="flex flex-wrap gap-1.5 mt-3">
          {(live || ["retry", "budget_paused", "uncertain"].includes(j.status)) && <button className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-white/[0.08] text-[12px] hover:bg-white/[0.05]" onClick={() => onAction("cancel")} data-testid={`button-cancel-${j.id}`}><Ban className="w-3.5 h-3.5" />Cancel</button>}
          {!live && (isFailed(j.status) || isCancelled(j.status)) && <button className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-white/[0.08] text-[12px] hover:bg-white/[0.05]" onClick={() => onAction("retry")} data-testid={`button-retry-${j.id}`}><RotateCw className="w-3.5 h-3.5" />Retry</button>}
          {uncertain && <span className="text-[12px] text-amber-300">Automatic AI recovery pending</span>}
          {readyIds.length > 1 && <DubButton className="h-8" pending={dub.pending} onClick={() => dub.start(readyIds)} testId={`button-dub-batch-${j.id}`}>Clone & Dub (ES / PT) all {readyIds.length}</DubButton>}
          {readyIds.length > 0 && <Link href="/vault" className="inline-flex items-center gap-1 h-8 px-2 text-[12px] text-emerald-400 hover:text-emerald-300">Vault <ArrowUpRight className="w-3 h-3" /></Link>}
        </div>
      </div>
      {j.clips.length > 0 ? (
        <div className="p-3 grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2.5">
          {j.clips.map((c) => <ClipTile key={`${c.index}-${c.language}-${c.clip?.id ?? "p"}`} c={c} jobId={j.id} pack={pack} dub={dub} />)}
        </div>
      ) : <div className="px-4 py-3 text-[11.5px] text-zinc-500 mono">Clip slots appear once moments are detected.</div>}
    </article>
  );
}

const CONFIRM: Record<JobActionAction, { title: string; body: string; cta: string }> = {
  cancel: { title: "Cancel this source?", body: "Processing stops at the next safe point. Compute or AI usage already started may still be billed, and the exact amount can be uncertain until the provider settles it.", cta: "I understand, cancel" },
  retry: { title: "Retry this source?", body: "A new attempt re-runs the failed stages. The previous attempt may already have incurred usage that cannot be confirmed yet, and the retry adds its own usage.", cta: "I understand, retry" },
  "acknowledge-uncertain": { title: "Retry this source?", body: "Saved successful results are reused. AI calls retry automatically up to three times, including ambiguous timeouts; earlier usage remains recorded and retries can incur additional charges.", cta: "Retry source" },
};

export default function Studio() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { isAuthenticated, isLoading: authLoading, login, user } = useAuth();
  const [text, setText] = useState("");
  const keyRef = useRef<string>(newKey());
  const fileRef = useRef<HTMLInputElement>(null);
  const { upload, uploading, progress, verifying, error: upErr } = useFileUpload();
  const [pending, setPending] = useState<Pending>(null);
  const pack = usePack();
  const dub = useDub();

  useEffect(() => { document.title = "Command Center · Veloce Engine"; }, []);

  const swarm = useGetAutopilotSwarm({ query: {
    queryKey: getGetAutopilotSwarmQueryKey(), enabled: isAuthenticated,
    refetchInterval: 2000, refetchOnWindowFocus: true, refetchOnReconnect: true, refetchIntervalInBackground: false,
  } });

  const sources = useMemo(() => parseSources(text), [text]);
  const tooMany = sources.length > MAX_SOURCES;
  const tooLong = sources.some((s) => s.length > 2048);

  const launch = useLaunchAutopilot({ mutation: {
    onSuccess: (r) => {
      keyRef.current = newKey();
      setText("");
      qc.invalidateQueries({ queryKey: getGetAutopilotSwarmQueryKey() });
      qc.invalidateQueries({ queryKey: getGetStudioSummaryQueryKey() });
      toast({ title: `Autopilot accepted ${r.jobIds.length} source${r.jobIds.length === 1 ? "" : "s"}`, description: `Server acceptance: ${r.acceptedMs.toFixed(1)} ms, excluding network and sign-in checks. Progress appears below.` });
    },
    onError: (e) => toast({ title: "Launch not accepted", description: `${errMsg(e)} Retrying sends the same request key, so it will not double-queue.`, variant: "destructive" }),
  } });

  const control = useControlAutopilotJob({ mutation: {
    onSuccess: (r) => { setPending(null); qc.invalidateQueries({ queryKey: getGetAutopilotSwarmQueryKey() }); qc.invalidateQueries({ queryKey: getListClipsQueryKey() }); qc.invalidateQueries({ queryKey: getGetAutopilotScheduleQueryKey() }); toast({ title: "Request recorded", description: r.message }); },
    onError: (e) => toast({ title: "Action failed", description: errMsg(e), variant: "destructive" }),
  } });

  function onEdit(v: string) {
    if (parseSources(v).join("\n") !== sources.join("\n")) keyRef.current = newKey();
    setText(v);
  }

  function doLaunch() {
    if (authLoading) return;
    if (!isAuthenticated) { login(); return; }
    if (!sources.length || tooMany || tooLong) return;
    launch.mutate({ data: { sources, idempotencyKey: keyRef.current } });
  }

  async function onFile(f: File | undefined) {
    if (!f) return;
    if (f.type !== "video/mp4") { toast({ title: "MP4 only", description: "Choose an .mp4 video file.", variant: "destructive" }); return; }
    const path = await upload(f);
    if (path) { onEdit(text.trim() ? `${text.trim()}\n${path}` : path); toast({ title: "Upload verified", description: `${f.name} added to the source list.` }); }
  }

  const jobs = swarm.data ?? [];
  const liveCount = jobs.filter(jobLive).length;
  const clipCount = jobs.reduce((n, j) => n + j.clips.length, 0);
  const readyCount = jobs.reduce((n, j) => n + j.clips.filter((c) => c.clip?.videoUrl && /ready|complete|done/i.test(c.status)).length, 0);
  const canLaunch = !authLoading && !launch.isPending && !uploading && (!isAuthenticated || (sources.length > 0 && !tooMany && !tooLong));

  return (
    <div>
      <PageHeader eyebrow="01 / Command Center" title="Paste. Launch. Watch it render." desc="Every source runs as an analytical commentary cut in 9:16 vertical by default. Clip counts, durations and timings are targets the pipeline aims for, not guarantees." />

      <section className="panel overflow-hidden rise">
        <div className="p-4 md:p-5">
          <label htmlFor="sources" className="block text-[13px] font-medium mb-2">Paste YouTube / Stream Links (1 or multiple per line)</label>
          <textarea id="sources" value={text} onChange={(e) => onEdit(e.target.value)} rows={5} spellCheck={false} autoCapitalize="off" autoCorrect="off" inputMode="url"
            placeholder={"https://www.youtube.com/watch?v=...\nhttps://www.twitch.tv/videos/..."}
            className="w-full rounded-lg bg-[#09090B] border border-white/[0.08] px-3.5 py-3 mono text-[16px] sm:text-[13px] leading-relaxed placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/10 resize-y transition"
            data-testid="input-sources" />
          <div className="flex justify-between mono text-[11px] mt-1.5 gap-3">
            <span className={tooMany || tooLong ? "text-amber-400" : "text-zinc-500"}>{tooMany ? `Up to ${MAX_SOURCES} sources per launch` : tooLong ? "A link exceeds 2048 characters" : "Defaults: commentary · vertical 9:16 · captions · latest active campaign bed"}</span>
            <span className="text-zinc-500 tabular-nums" data-testid="text-source-count">{sources.length}/{MAX_SOURCES}</span>
          </div>
          <button onClick={doLaunch} disabled={!canLaunch}
            className="mt-3 w-full h-12 rounded-lg bg-emerald-500 text-[#06130D] text-[14px] font-bold tracking-[0.14em] inline-flex items-center justify-center gap-2 hover:bg-emerald-400 active:scale-[.99] transition disabled:opacity-40 disabled:pointer-events-none touch-manipulation"
            data-testid="button-launch-autopilot">
            {!authLoading && !isAuthenticated ? <Lock className="w-4 h-4" /> : <Rocket className="w-4 h-4" />}
            {launch.isPending ? "LAUNCHING..." : "LAUNCH AUTOPILOT"}
          </button>
          {!authLoading && !isAuthenticated && <p className="text-[11.5px] text-zinc-500 mt-2 text-center">You will be asked to log in first. Your sources stay private to your account.</p>}
        </div>

        <div className="border-t border-dashed border-white/[0.08] px-4 md:px-5 py-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <input ref={fileRef} type="file" accept="video/mp4" className="hidden" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} data-testid="input-file-mp4" />
          <span className="text-[11.5px] text-zinc-600">Secondary</span>
          <button type="button" onClick={() => (isAuthenticated ? fileRef.current?.click() : login())} disabled={uploading}
            className="inline-flex items-center gap-1.5 text-[12.5px] text-zinc-300 underline underline-offset-4 decoration-white/20 hover:decoration-emerald-400 hover:text-emerald-300 disabled:opacity-50" data-testid="link-upload-mp4">
            <Upload className="w-3.5 h-3.5" />{uploading ? (verifying ? "Verifying upload..." : `Uploading ${progress}%`) : "Or upload local MP4"}
          </button>
          {upErr && <span className="mono text-[11px] text-red-400">{upErr}</span>}
          {uploading && <div className="basis-full h-1 rounded-full bg-white/[0.06] overflow-hidden"><div className="h-full bg-emerald-500 origin-left transition-transform" style={{ transform: `scaleX(${progress / 100})` }} /></div>}
        </div>

        <div className="border-t border-white/[0.06] bg-white/[0.012] px-4 md:px-5 py-3 flex gap-2.5 text-[11.5px] text-zinc-400 leading-relaxed" data-testid="text-authorized-terms">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
          <p>Authorized use only. Launching applies these terms: submit streams you own or are licensed to clip, add commentary, and republish. Veloce Engine does not verify ownership for you, and outputs publish only to accounts you authorize.</p>
        </div>
      </section>

      {isAuthenticated && <RenderBudgetSettings />}
      {isAuthenticated && <AIUsagePanel key={user?.id ?? "anon"} />}
      <section className="mt-7">
        <div className="flex items-end justify-between mb-3 gap-3">
          <div>
            <h2 className="text-[15px] font-semibold flex items-center gap-2">Active Swarm {liveCount > 0 && <Pill tone="emerald" dot>{liveCount} running</Pill>}</h2>
            <p className="mono text-[11px] text-zinc-500 mt-0.5" data-testid="text-swarm-counts">{jobs.length} sources · {clipCount} clip slots · {readyCount} ready</p>
          </div>
          {swarm.isFetching && isAuthenticated && <span className="mono text-[10.5px] text-zinc-600">syncing</span>}
        </div>
        {authLoading || (isAuthenticated && swarm.isLoading) ? <div className="space-y-3">{[0, 1].map((i) => <Sk key={i} className="h-56" />)}</div>
          : !isAuthenticated ? <EmptyState icon={<Lock className="w-4 h-4" />} title="Log in to see your swarm" desc="Sources, clips and private MP4s are scoped to your account." action={<button onClick={login} className="h-8 px-3 rounded-md bg-emerald-500 text-[#06130D] text-[12.5px] font-semibold" data-testid="button-login">Log in</button>} />
          : swarm.isError ? <ErrorState title="Swarm unavailable" error={swarm.error} onRetry={() => swarm.refetch()} />
          : !jobs.length ? <EmptyState icon={<Radio className="w-4 h-4" />} title="Nothing in flight" desc="Paste one or more authorized links above. Each source appears here immediately with live stage, progress and per-clip status." />
          : <div className="space-y-3">{jobs.map((j) => <JobCard key={j.id} j={j} pack={pack} dub={dub} onAction={(action) => setPending({ job: j, action })} />)}</div>}
        {isAuthenticated && jobs.length > 0 && <div className="mt-4 flex items-center gap-2 text-[11.5px] text-zinc-500"><Film className="w-3.5 h-3.5" />Ready clips also appear in the <Link href="/vault" className="text-emerald-400">Clip Vault</Link>. Auto-posting is configured in <Link href="/distribution" className="text-emerald-400">Schedule & Accounts</Link>.</div>}
      </section>

      <Dialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent className="bg-[#121215] border-white/[0.08] max-w-[calc(100vw-24px)] sm:max-w-md">
          {pending && <>
            <DialogTitle className="text-[15px]">{CONFIRM[pending.action].title}</DialogTitle>
            <DialogDescription className="text-[12.5px] leading-relaxed">{CONFIRM[pending.action].body}</DialogDescription>
            <div className="mono text-[11px] text-zinc-500 truncate">JOB {pending.job.id} · {pending.job.title}</div>
            <div className="flex justify-end gap-2">
              <button className="h-9 px-3 rounded-md border border-white/[0.08] text-[12.5px]" onClick={() => setPending(null)}>Back</button>
              <button className="h-9 px-3 rounded-md bg-amber-500 text-[#1a1203] text-[12.5px] font-semibold disabled:opacity-40" disabled={control.isPending}
                onClick={() => control.mutate({ id: pending.job.id, data: { action: pending.action } })} data-testid="button-confirm-action">{control.isPending ? "Sending..." : CONFIRM[pending.action].cta}</button>
            </div>
          </>}
        </DialogContent>
      </Dialog>
      {pack.dialog}
    </div>
  );
}
