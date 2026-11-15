import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@workspace/replit-auth-web";
import {
  useGetStudioSummary, getGetStudioSummaryQueryKey, useListTrendingSources, getListTrendingSourcesQueryKey,
  useListProjects, getListProjectsQueryKey, useCreateProject, useDeleteProject, useListCampaigns, getListCampaignsQueryKey,
  getListClipsQueryKey, useGetProject, getGetProjectQueryKey, type Project, type ProjectInputMode,
} from "@workspace/api-client-react";
import { Link2, Upload, Play, Sparkles, Trash2, ShieldCheck, Mic, BookText, BadgeDollarSign, ArrowUpRight, Radio, FlaskConical, Lock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { useFileUpload } from "@/hooks/use-file-upload";
import { cn } from "@/lib/utils";
import { PageHeader, Pill, DemoTag, Stat, Sk, ErrorState, EmptyState, STAGES, isActiveStatus, statusTone, errMsg, fmtMoney, btn, field } from "@/components/kit";

const MODES: { id: ProjectInputMode; label: string; icon: typeof Mic; desc: string }[] = [
  { id: "commentary", label: "Commentary", icon: Mic, desc: "Reaction hook + voice-over beats" },
  { id: "story", label: "Story", icon: BookText, desc: "Narrative arc across the moment" },
  { id: "bounty", label: "Bounty", icon: BadgeDollarSign, desc: "Campaign CTA and affiliate overlay" },
];

const URL_RE = /^(https?:\/\/)?(www\.|m\.)?(youtube\.com|youtu\.be|twitch\.tv|kick\.com)\/.+/i;

function ProjectRow({ p, onDelete, deleting }: { p: Project; onDelete: () => void; deleting: boolean }) {
  const qc = useQueryClient();
  const active = isActiveStatus(p.status);
  const detail = useGetProject(p.id, { query: { queryKey: getGetProjectQueryKey(p.id), enabled: active, refetchInterval: active ? 2000 : false } });
  const live = detail.data ?? p;
  const wasActive = useRef(active);
  useEffect(() => {
    if (wasActive.current && !isActiveStatus(live.status)) {
      qc.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      qc.invalidateQueries({ queryKey: getListClipsQueryKey() });
      qc.invalidateQueries({ queryKey: getGetStudioSummaryQueryKey() });
    }
    wasActive.current = isActiveStatus(live.status);
  }, [live.status, qc]);
  const running = isActiveStatus(live.status);
  const failed = ["failed", "error"].includes(live.status.toLowerCase());
  return (
    <div className="px-4 py-3.5 border-b border-white/[0.05] last:border-0 rise" data-testid={`row-project-${p.id}`}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-medium truncate max-w-[340px]">{live.title}</span>
            {live.demo && <DemoTag />}
            <Pill tone={statusTone(live.status)} dot={running}>{live.status}</Pill>
          </div>
          <div className="mono text-[11px] text-muted-foreground mt-1 truncate">{live.mode} · {live.clipCount} clip{live.clipCount > 1 ? "s" : ""} · {live.sourceUrl}</div>
        </div>
        <span className="mono text-[11px] text-zinc-500 whitespace-nowrap hidden sm:block">{formatDistanceToNow(new Date(live.createdAt), { addSuffix: true })}</span>
        <button onClick={onDelete} disabled={deleting || running} className={btn.icon} aria-label="Delete batch" data-testid={`button-delete-project-${p.id}`}><Trash2 className="w-3.5 h-3.5" /></button>
      </div>
      <div className="mt-3 grid grid-cols-6 gap-1">
        {STAGES.map((s, i) => {
          const done = live.stage > i || (!running && !failed);
          const cur = running && live.stage === i;
          return (
            <div key={s}>
              <div className={cn("h-1 rounded-full relative overflow-hidden", done ? "bg-emerald-500" : cur ? "bg-emerald-500/25 scan" : failed && live.stage === i ? "bg-red-500/60" : "bg-white/[0.06]")} />
              <div className={cn("text-[9.5px] mono mt-1 uppercase tracking-wide truncate", cur ? "text-emerald-400" : done ? "text-zinc-400" : "text-zinc-600")}>{s}</div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between mt-2">
        <span className="mono text-[11px] text-zinc-500">stage {live.stage}/5</span>
        <span className="mono text-[11px] tabular-nums text-zinc-400">{Math.round(live.progress)}%</span>
      </div>
      {live.error && <div className="mt-2 text-[12px] text-red-400 mono bg-red-500/5 border border-red-500/15 rounded-md px-2.5 py-1.5 whitespace-pre-wrap break-words">{live.error}{live.error.includes("Upload an authorized MP4") && <p className="mt-2 text-zinc-300">Use the upload control above, select your own MP4, then generate a new batch. Uploading automatically turns off Demo run.</p>}</div>}
      {!running && !failed && <Link href="/vault" className="mt-2 inline-flex items-center gap-1 text-[12px] text-emerald-400 hover:text-emerald-300">Open in Vault <ArrowUpRight className="w-3 h-3" /></Link>}
    </div>
  );
}

export default function Studio() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { isAuthenticated, isLoading: authLoading, login } = useAuth();
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<ProjectInputMode>("commentary");
  const [count, setCount] = useState(3);
  const [campaignId, setCampaignId] = useState<string>("");
  const [rights, setRights] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { upload, uploading, progress: uploadProgress, verifying, error: upErr } = useFileUpload();

  useEffect(() => { document.title = "Studio · Veloce Engine"; }, []);

  const summary = useGetStudioSummary({ query: { queryKey: getGetStudioSummaryQueryKey(), refetchInterval: 5000 } });
  const trending = useListTrendingSources({ query: { queryKey: getListTrendingSourcesQueryKey(), enabled: !authLoading && !isAuthenticated } });
  const projects = useListProjects({ query: { queryKey: getListProjectsQueryKey(), refetchInterval: (q) => (q.state.data?.some((p) => isActiveStatus(p.status)) ? 3000 : false) } });
  const campaigns = useListCampaigns({ query: { queryKey: getListCampaignsQueryKey() } });

  const create = useCreateProject({
    mutation: {
      onSuccess: (p) => {
        qc.invalidateQueries({ queryKey: getListProjectsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetStudioSummaryQueryKey() });
        toast({ title: p.demo ? "Demo batch queued" : "Batch queued", description: p.demo ? "Simulated pipeline. No media is processed in demo mode." : "Tracking real pipeline progress below." });
      },
      onError: (e) => toast({ title: "Could not start batch", description: errMsg(e), variant: "destructive" }),
    },
  });
  const del = useDeleteProject({
    mutation: {
      onSuccess: () => { qc.invalidateQueries({ queryKey: getListProjectsQueryKey() }); qc.invalidateQueries({ queryKey: getListClipsQueryKey() }); qc.invalidateQueries({ queryKey: getGetStudioSummaryQueryKey() }); },
      onError: (e) => toast({ title: "Delete failed", description: errMsg(e), variant: "destructive" }),
    },
  });

  const isObj = url.startsWith("/objects/");
  const urlValid = isObj || URL_RE.test(url.trim());
  const effectiveDemo = !isAuthenticated;
  const visibleProjects = projects.data?.filter((p) => !isAuthenticated || !p.demo);
  const canSubmit = !authLoading && !uploading && urlValid && rights && !create.isPending && (mode !== "bounty" || !!campaignId);

  function submit(override?: { url: string; demo: boolean }) {
    const src = override?.url ?? url.trim();
    create.mutate({ data: { sourceUrl: src, mode, clipCount: count, rightsConfirmed: true, demo: override?.demo ?? effectiveDemo, ...(campaignId ? { campaignId: Number(campaignId) } : {}) } });
  }

  function tryDemo() {
    if (isAuthenticated || authLoading) return;
    const first = trending.data?.[0];
    if (!first) { toast({ title: "No demo sources available", description: "The curated demo list did not load." }); return; }
    setUrl(first.url); setRights(true);
    submit({ url: first.url, demo: true });
  }

  async function onFile(f: File | undefined) {
    if (!f) return;
    if (!isAuthenticated) { toast({ title: "Log in required", description: "Uploads are stored privately and need an account." }); return; }
    const path = await upload(f);
    if (path) { setUrl(path); toast({ title: "Upload complete", description: f.name }); }
  }

  const s = summary.data;
  const caps = s?.capabilities;

  return (
    <div>
      <PageHeader eyebrow="01 / Studio" title="Production Studio" desc="Turn authorized stream footage into scored, commentary-led vertical drafts. Scores are heuristics for triage, not performance guarantees."
        actions={!authLoading && !isAuthenticated ? <button onClick={tryDemo} disabled={create.isPending || trending.isLoading} className={btn.ghost} data-testid="button-try-demo"><FlaskConical className="w-3.5 h-3.5 text-amber-400" /> Try demo</button> : undefined} />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
        {summary.isLoading ? [0, 1, 2, 3, 4].map((i) => <Sk key={i} className="h-[84px]" />) : summary.isError ? <div className="col-span-full"><ErrorState title="Summary unavailable" error={summary.error} onRetry={() => summary.refetch()} /></div> : s && (
          <>
            <Stat label="Clips in vault" value={s.totalClips} sub={`${s.readyClips} ready`} />
            <Stat label="Active batches" value={s.activeBatches} sub={s.activeBatches ? "polling live" : "idle"} accent={s.activeBatches ? "emerald" : undefined} />
            <Stat label="Avg heuristic score" value={s.averageScore.toFixed(1)} sub="not a guarantee" />
            <Stat label="Projected payout" value={fmtMoney(s.estimatedPayout)} sub="from campaign CPM" accent="amber" />
            <div className="panel px-4 py-3.5 col-span-2 lg:col-span-1">
              <div className="label-xs">Capabilities</div>
              <div className="flex flex-wrap gap-1 mt-2">
                {caps && (Object.entries(caps) as [string, boolean][]).map(([k, v]) => <Pill key={k} tone={v ? "emerald" : "neutral"}>{k}</Pill>)}
              </div>
              {!authLoading && !isAuthenticated && s.demo && <div className="text-[11px] text-amber-400/80 mt-2">Workspace data is demo</div>}
            </div>
          </>
        )}
      </div>

      <div className="grid lg:grid-cols-[1fr_340px] gap-5">
        <div className="space-y-5 min-w-0">
          {/* Composer */}
          <div className="panel overflow-hidden rise">
            <div className="p-4 md:p-5 space-y-5">
              <div>
                <label className="label-xs" htmlFor="src">Source</label>
                <div className="mt-2 flex flex-col sm:flex-row gap-2">
                  <div className="relative flex-1">
                    <Link2 className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                    <input id="src" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste YouTube / Twitch / VOD URL" className={cn(field, "pl-9 h-10 mono text-[12.5px]")} data-testid="input-source-url" />
                  </div>
                  <input ref={fileRef} type="file" accept="video/mp4" className="hidden" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
                  <button className={cn(btn.ghost, "h-10")} onClick={() => (isAuthenticated ? fileRef.current?.click() : login())} disabled={uploading} data-testid="button-upload-source">
                    {isAuthenticated ? <Upload className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
                    {uploading ? verifying ? "Verifying… 100%" : `Uploading… ${uploadProgress}%` : "Upload MP4"}
                  </button>
                </div>
                {uploading && <progress className="mt-2 h-1 w-full accent-emerald-500" max={100} value={uploadProgress} aria-label="Upload progress" />}
                <div className="mt-1.5 text-[11px] mono min-h-4">
                  {upErr ? <span className="text-red-400">{upErr}</span> : url && !urlValid ? <span className="text-amber-400">Use a YouTube, Twitch, or Kick URL, or upload an MP4.</span> : isObj ? <span className="text-emerald-400">Private upload verified · source must be 30s–60m</span> : <span className="text-zinc-500">Full completed VOD: 30s–60m, up to 2 GB · MP4: up to 500 MB</span>}
                </div>
              </div>

              <div>
                <div className="label-xs mb-2">Preset</div>
                <div className="grid sm:grid-cols-3 gap-2">
                  {MODES.map((m) => (
                    <button key={m.id} onClick={() => setMode(m.id)} data-testid={`button-mode-${m.id}`}
                      className={cn("text-left rounded-lg border p-3 transition", mode === m.id ? "border-emerald-500/40 bg-emerald-500/[0.05]" : "border-white/[0.08] hover:border-white/[0.16] bg-[#09090B]")}>
                      <div className="flex items-center gap-2"><m.icon className={cn("w-3.5 h-3.5", mode === m.id ? "text-emerald-400" : "text-zinc-500")} /><span className="text-[13px] font-medium">{m.label}</span></div>
                      <div className="text-[11.5px] text-muted-foreground mt-1">{m.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <div className="label-xs mb-2">Clips per batch</div>
                  <div className="inline-flex rounded-md border border-white/[0.08] p-0.5 bg-[#09090B]">
                    {[1, 2, 3, 4].map((n) => (
                      <button key={n} onClick={() => setCount(n)} data-testid={`button-count-${n}`} className={cn("w-10 h-7 rounded mono text-[12.5px] transition", count === n ? "bg-white/[0.09] text-foreground" : "text-zinc-500 hover:text-zinc-300")}>{n}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="label-xs mb-2">Campaign {mode === "bounty" ? <span className="text-amber-400">required</span> : "(optional)"}</div>
                  <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} className={field} data-testid="select-campaign">
                    <option value="">None</option>
                    {campaigns.data?.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.brand}</option>)}
                  </select>
                </div>
              </div>

              <div className="flex flex-col gap-2.5">
                <label className="flex items-start gap-2.5 cursor-pointer select-none">
                  <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} className="mt-0.5 accent-emerald-500" data-testid="checkbox-rights" />
                  <span className="text-[12.5px] text-zinc-300"><ShieldCheck className="w-3.5 h-3.5 inline -mt-0.5 mr-1 text-emerald-400" />I own this footage or have the creator's permission to clip and publish it with commentary.</span>
                </label>
                <label className="flex items-center gap-2.5 select-none opacity-70">
                  <input type="checkbox" checked={effectiveDemo} disabled className="accent-amber-500" data-testid="checkbox-demo" />
                  <span className="text-[12.5px] text-zinc-300">Demo run <span className="text-muted-foreground">{isAuthenticated ? "off — signed-in batches process real media" : "simulated pipeline, no media processed (required while logged out)"}</span></span>
                </label>
              </div>
            </div>
            <div className="border-t border-white/[0.06] px-4 md:px-5 py-3 flex items-center justify-between gap-3 bg-white/[0.01]">
              <span className="mono text-[11px] text-zinc-500">{effectiveDemo ? "DEMO · simulated" : "LIVE · real media job"} · {mode} · x{count}</span>
              <button onClick={() => submit()} disabled={!canSubmit} className={btn.primary} data-testid="button-generate">
                <Sparkles className="w-3.5 h-3.5" /> {create.isPending ? "Queuing..." : "Generate batch"}
              </button>
            </div>
          </div>

          {/* Batches */}
          <div>
            <div className="flex items-center justify-between mb-2.5">
              <h2 className="text-[13px] font-semibold">Batches</h2>
              {projects.data?.some((p) => isActiveStatus(p.status)) && <Pill tone="emerald" dot>Live polling</Pill>}
            </div>
            {projects.isLoading ? <div className="space-y-2">{[0, 1].map((i) => <Sk key={i} className="h-28" />)}</div>
              : projects.isError ? <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
              : !visibleProjects?.length ? <EmptyState icon={<Play className="w-4 h-4" />} title="No batches yet" desc={isAuthenticated ? "Paste an authorized VOD URL or upload an MP4 above to create your first real batch." : "Run a demo batch to see how the pipeline stages progress."} action={!isAuthenticated ? <button onClick={tryDemo} className={btn.ghost}>Try demo</button> : undefined} />
              : <div className="panel">{visibleProjects.map((p) => <ProjectRow key={p.id} p={p} deleting={del.isPending} onDelete={() => { if (confirm(`Delete "${p.title}" and its clips?`)) del.mutate({ id: p.id }); }} />)}</div>}
          </div>
        </div>

        <div className="space-y-5">
          {!authLoading && !isAuthenticated && <div>
            <div className="flex items-center justify-between mb-2.5">
              <h2 className="text-[13px] font-semibold">Curated sources</h2>
              <Pill tone="amber">Demo · not live</Pill>
            </div>
            {trending.isLoading ? <div className="space-y-2">{[0, 1, 2].map((i) => <Sk key={i} className="h-16" />)}</div>
              : trending.isError ? <ErrorState error={trending.error} onRetry={() => trending.refetch()} />
              : !trending.data?.length ? <EmptyState icon={<Radio className="w-4 h-4" />} title="No curated sources" desc="Demo sources will appear here." />
              : <div className="space-y-1.5">{trending.data.map((t) => (
                <button key={t.id} onClick={() => { setUrl(t.url); toast({ title: "Demo source selected", description: `${t.title} loaded in demo mode.` }); }} data-testid={`button-trending-${t.id}`}
                  className={cn("w-full flex gap-3 p-2 rounded-lg border text-left transition", url === t.url ? "border-emerald-500/40 bg-emerald-500/[0.04]" : "border-white/[0.06] bg-[#121215] hover:border-white/[0.14]")}>
                  <img src={t.thumbnail} alt="" className="w-20 h-12 rounded object-cover bg-white/5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium truncate">{t.title}</div>
                    <div className="text-[11px] text-muted-foreground truncate">{t.creator} · {t.category}</div>
                    <div className="mono text-[10px] text-zinc-500 mt-0.5">{t.platform} · {t.viewers} sample viewers</div>
                  </div>
                </button>))}</div>}
          </div>}

          <div>
            <h2 className="text-[13px] font-semibold mb-2.5">Activity</h2>
            <div className="panel p-1">
              {summary.isLoading ? <Sk className="h-24 m-2" /> : !s?.activity.length ? <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">No activity recorded yet.</div> :
                s.activity.slice(0, 8).map((a) => (
                  <div key={a.id} className="flex gap-2.5 px-3 py-2">
                    <span className="w-1 h-1 rounded-full bg-emerald-500 mt-2 shrink-0" />
                    <div className="min-w-0"><div className="text-[12px] text-zinc-300">{a.message}</div><div className="mono text-[10.5px] text-zinc-600">{formatDistanceToNow(new Date(a.createdAt), { addSuffix: true })}</div></div>
                  </div>))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
