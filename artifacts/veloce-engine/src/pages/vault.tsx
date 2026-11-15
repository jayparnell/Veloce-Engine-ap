import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListClips, getListClipsQueryKey, useUpdateClip, useDeleteClip, useCreateExport, useListCampaigns, getListCampaignsQueryKey,
  getGetStudioSummaryQueryKey, type Clip, type ExportResult,
} from "@workspace/api-client-react";
import { Search, Film, Download, Trash2, Save, Play, Pause, Captions, PictureInPicture2, Type, Grid3x3, Info, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { PageHeader, Pill, DemoTag, Sk, ErrorState, EmptyState, ScoreBar, statusTone, errMsg, fmtDur, btn, field } from "@/components/kit";

type Draft = { title: string; hook: string; script: string; hashtags: string; pinnedComment: string; captions: boolean; pictureInPicture: boolean; campaignId: number | null };
const toDraft = (c: Clip): Draft => ({ title: c.title, hook: c.hook, script: c.script, hashtags: c.hashtags, pinnedComment: c.pinnedComment, captions: c.captions, pictureInPicture: c.pictureInPicture, campaignId: c.campaignId ?? null });

function Preview({ clip, d, showHook, safe }: { clip: Clip; d: Draft; showHook: boolean; safe: boolean }) {
  const vRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const dur = clip.duration || 1;
  const hasVideo = !!clip.videoUrl;
  useEffect(() => { setT(0); setPlaying(false); }, [clip.id]);
  function toggle() {
    const v = vRef.current; if (!v) return;
    if (v.paused) { v.play(); setPlaying(true); } else { v.pause(); setPlaying(false); }
  }
  function seek(val: number) { setT(val); if (vRef.current) vRef.current.currentTime = val; }
  const words = d.hook.split(" ");
  const capIdx = Math.min(words.length - 1, Math.floor((t / dur) * words.length));
  return (
    <div className="flex flex-col items-center">
      <div className="relative w-full max-w-[280px] aspect-[9/16] rounded-[14px] overflow-hidden border border-white/[0.1] bg-[#050506] shadow-[0_30px_60px_-20px_rgba(0,0,0,.8)]">
        {hasVideo ? (
          <video ref={vRef} src={clip.videoUrl} poster={clip.thumbnail} className="absolute inset-0 w-full h-full object-cover" onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onEnded={() => setPlaying(false)} playsInline data-testid="video-preview" />
        ) : (
          <>
            <img src={clip.thumbnail} alt="" className="absolute inset-0 w-full h-full object-cover blur-xl scale-110 opacity-50" />
            <img src={clip.thumbnail} alt={clip.title} className="absolute inset-x-0 top-1/2 -translate-y-1/2 w-full aspect-video object-cover" />
          </>
        )}
        {d.pictureInPicture && (
          <div className="absolute top-14 right-3 w-[30%] aspect-square rounded-lg border-2 border-emerald-500/70 bg-zinc-900/80 flex items-center justify-center">
            <span className="mono text-[8px] text-emerald-300 text-center leading-tight">FACECAM<br />SLOT</span>
          </div>
        )}
        {showHook && d.hook && <div className="absolute top-4 inset-x-3 text-center"><span className="inline bg-amber-400 text-[#1a1203] text-[12px] font-bold leading-snug px-1.5 py-0.5 box-decoration-clone">{d.hook}</span></div>}
        {d.captions && d.hook && (
          <div className="absolute bottom-[22%] inset-x-4 text-center text-[15px] font-extrabold text-white [text-shadow:0_2px_0_#000,0_0_8px_#000] uppercase">
            {words.slice(Math.max(0, capIdx - 1), capIdx + 2).map((w, i) => <span key={i} className={i === Math.min(1, capIdx) ? "text-emerald-400" : ""}>{w} </span>)}
          </div>
        )}
        {safe && <div className="absolute inset-x-[6%] top-[8%] bottom-[18%] border border-dashed border-sky-400/60 rounded pointer-events-none"><span className="mono text-[8px] text-sky-300 absolute -top-3 left-0">SAFE ZONE</span></div>}
        {!hasVideo && (
          <div className="absolute bottom-3 inset-x-3 rounded-md bg-black/70 border border-white/10 px-2.5 py-1.5 backdrop-blur">
            <div className="mono text-[9.5px] text-amber-400 uppercase tracking-wider">{clip.demo ? "Sample · no render" : "Render not available"}</div>
            <div className="text-[10.5px] text-zinc-400 leading-snug">Poster preview only. Overlays are layout previews.</div>
          </div>
        )}
      </div>
      <div className="w-full max-w-[280px] mt-3">
        <div className="flex items-center gap-2">
          <button onClick={toggle} disabled={!hasVideo} className={btn.icon} data-testid="button-play">{playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}</button>
          <input type="range" min={0} max={dur} step={0.1} value={t} onChange={(e) => seek(Number(e.target.value))} className="flex-1 accent-emerald-500 h-1" data-testid="input-scrubber" />
          <span className="mono text-[10.5px] text-zinc-400 tabular-nums w-[72px] text-right">{fmtDur(t)} / {fmtDur(dur)}</span>
        </div>
        {!hasVideo && <div className="text-[10.5px] text-zinc-500 mt-1 text-center">Scrubber previews caption timing against the clip duration.</div>}
      </div>
    </div>
  );
}

export default function Vault() {
  const qc = useQueryClient();
  const { toast } = useToast();
  useEffect(() => { document.title = "Clip Vault · Veloce Engine"; }, []);
  const clips = useListClips({ query: { queryKey: getListClipsQueryKey(), refetchInterval: 3000 } });
  const campaigns = useListCampaigns({ query: { queryKey: getListCampaignsQueryKey() } });
  const [q, setQ] = useState("");
  const [modeF, setModeF] = useState("all");
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [activeId, setActiveId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showHook, setShowHook] = useState(true);
  const [safe, setSafe] = useState(false);
  const [exportRes, setExportRes] = useState<ExportResult | null>(null);
  const [confirmDel, setConfirmDel] = useState<Clip | null>(null);
  const initFor = useRef<number | null>(null);

  const list = useMemo(() => (clips.data ?? []).filter((c) => (modeF === "all" || c.mode === modeF) && (c.title + c.creator + c.hashtags).toLowerCase().includes(q.toLowerCase())), [clips.data, q, modeF]);
  const active = clips.data?.find((c) => c.id === activeId) ?? null;

  useEffect(() => { if (activeId == null && list.length) setActiveId(list[0].id); }, [list, activeId]);
  useEffect(() => { if (active && initFor.current !== active.id) { initFor.current = active.id; setDraft(toDraft(active)); } }, [active]);

  const invalidate = () => { qc.invalidateQueries({ queryKey: getListClipsQueryKey() }); qc.invalidateQueries({ queryKey: getGetStudioSummaryQueryKey() }); };
  const update = useUpdateClip({ mutation: { onSuccess: () => { invalidate(); toast({ title: "Clip saved", description: "Metadata and layout preferences stored. Existing renders are not regenerated." }); }, onError: (e) => toast({ title: "Save failed", description: errMsg(e), variant: "destructive" }) } });
  const del = useDeleteClip({ mutation: { onSuccess: (_, v) => { invalidate(); setSel((s) => { const n = new Set(s); n.delete(v.id); return n; }); if (v.id === activeId) { setActiveId(null); initFor.current = null; } setConfirmDel(null); toast({ title: "Clip deleted" }); }, onError: (e) => toast({ title: "Delete failed", description: errMsg(e), variant: "destructive" }) } });
  const exp = useCreateExport({ mutation: { onSuccess: (r) => setExportRes(r), onError: (e) => toast({ title: "Export failed", description: errMsg(e), variant: "destructive" }) } });

  const dirty = !!(active && draft && JSON.stringify(toDraft(active)) !== JSON.stringify(draft));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const toggleSel = (id: number) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div>
      <PageHeader eyebrow="02 / Vault" title="Clip Vault & Editor" desc="Review drafts, tune metadata and preview layouts. Overlay toggles are previews; saving persists metadata and layout preferences without re-rendering."
        actions={sel.size > 0 ? (<>
          <span className="mono text-[11.5px] text-zinc-400">{sel.size} selected</span>
          <button className={btn.ghost} onClick={() => setSel(new Set())}><X className="w-3.5 h-3.5" /> Clear</button>
          <button className={btn.primary} disabled={exp.isPending || sel.size > 20} onClick={() => exp.mutate({ data: { clipIds: [...sel] } })} data-testid="button-bulk-export"><Download className="w-3.5 h-3.5" /> {exp.isPending ? "Packaging..." : "Export ZIP"}</button>
        </>) : undefined} />

      {clips.isLoading ? <div className="grid lg:grid-cols-[320px_1fr] gap-5"><Sk className="h-[520px]" /><Sk className="h-[520px]" /></div>
        : clips.isError ? <ErrorState error={clips.error} onRetry={() => clips.refetch()} />
        : !clips.data?.length ? <EmptyState icon={<Film className="w-4 h-4" />} title="The vault is empty" desc="Generated clips land here once a batch finishes in the Studio." action={<Link href="/" className={btn.primary}>Go to Studio</Link>} />
        : (
        <div className="grid lg:grid-cols-[320px_1fr] gap-5">
          <div className="panel flex flex-col lg:max-h-[calc(100dvh-170px)] lg:sticky lg:top-6 min-h-0">
            <div className="p-2.5 border-b border-white/[0.06] space-y-2">
              <div className="relative"><Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, creator, tags" className={cn(field, "pl-8 h-8")} data-testid="input-search" /></div>
              <div className="flex gap-1">
                {["all", "commentary", "story", "bounty"].map((m) => <button key={m} onClick={() => setModeF(m)} className={cn("h-6 px-2 rounded text-[11px] capitalize transition", modeF === m ? "bg-white/[0.08] text-foreground" : "text-zinc-500 hover:text-zinc-300")}>{m}</button>)}
                <button className="ml-auto text-[11px] text-zinc-500 hover:text-zinc-300" onClick={() => setSel(sel.size === list.length ? new Set() : new Set(list.map((c) => c.id)))} data-testid="button-select-all">{sel.size === list.length && list.length ? "None" : "All"}</button>
              </div>
            </div>
            <div className="overflow-y-auto flex-1 p-1.5 space-y-0.5 max-h-[360px] lg:max-h-none">
              {list.length === 0 && <div className="text-center text-[12px] text-muted-foreground py-8">No clips match.</div>}
              {list.map((c) => (
                <div key={c.id} onClick={() => setActiveId(c.id)} data-testid={`card-clip-${c.id}`} className={cn("flex items-center gap-2.5 p-1.5 rounded-md cursor-pointer transition", c.id === activeId ? "bg-white/[0.06]" : "hover:bg-white/[0.03]")}>
                  <input type="checkbox" checked={sel.has(c.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggleSel(c.id)} className="accent-emerald-500" data-testid={`checkbox-clip-${c.id}`} />
                  <div className="relative w-9 h-14 rounded overflow-hidden shrink-0 bg-white/5"><img src={c.thumbnail} alt="" className="w-full h-full object-cover" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] truncate">{c.title}</div>
                    <div className="text-[10.5px] text-muted-foreground truncate">{c.creator}</div>
                    <div className="flex items-center gap-1 mt-1">{c.demo && <DemoTag />}<Pill tone={statusTone(c.status)}>{c.status}</Pill></div>
                  </div>
                  <div className={cn("mono text-[13px] tabular-nums", c.score >= 70 ? "text-emerald-400" : c.score >= 45 ? "text-amber-400" : "text-zinc-500")}>{c.score.toFixed(0)}</div>
                </div>
              ))}
            </div>
          </div>

          {active && draft ? (
            <div className="panel rise" key={active.id}>
              <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><span className="text-[13.5px] font-medium truncate">{active.title}</span>{active.demo && <DemoTag />}</div>
                  <div className="mono text-[10.5px] text-zinc-500">#{active.id} · {active.mode} · {fmtDur(active.duration)} · {active.platforms.join(", ") || "no platforms"}</div>
                </div>
                <button className={btn.ghost} disabled={exp.isPending} onClick={() => exp.mutate({ data: { clipIds: [active.id] } })} data-testid="button-export-clip"><Download className="w-3.5 h-3.5" /> Export</button>
                <button className={btn.danger} onClick={() => setConfirmDel(active)} data-testid="button-delete-clip"><Trash2 className="w-3.5 h-3.5" /></button>
                <button className={btn.primary} disabled={!dirty || update.isPending || !draft.title.trim()} onClick={() => update.mutate({ id: active.id, data: draft })} data-testid="button-save-clip"><Save className="w-3.5 h-3.5" /> {update.isPending ? "Saving..." : "Save"}</button>
              </div>
              <div className="grid xl:grid-cols-[300px_1fr] gap-6 p-4 md:p-5">
                <div>
                  <Preview clip={active} d={draft} showHook={showHook} safe={safe} />
                  <div className="mt-4 grid grid-cols-2 gap-1.5 max-w-[280px] mx-auto">
                    {[
                      { on: draft.captions, f: () => set("captions", !draft.captions), icon: Captions, l: "Captions", p: true },
                      { on: draft.pictureInPicture, f: () => set("pictureInPicture", !draft.pictureInPicture), icon: PictureInPicture2, l: "Facecam PiP", p: true },
                      { on: showHook, f: () => setShowHook(!showHook), icon: Type, l: "Hook title", p: false },
                      { on: safe, f: () => setSafe(!safe), icon: Grid3x3, l: "Safe zones", p: false },
                    ].map((o) => (
                      <button key={o.l} onClick={o.f} data-testid={`toggle-${o.l.toLowerCase().replace(/\s/g, "-")}`} className={cn("flex items-center gap-1.5 h-8 px-2 rounded-md border text-[11.5px] transition", o.on ? "border-emerald-500/40 bg-emerald-500/[0.07] text-emerald-300" : "border-white/[0.08] text-zinc-400 hover:border-white/[0.16]")}>
                        <o.icon className="w-3.5 h-3.5" /> {o.l}{o.p && <span className="ml-auto mono text-[8.5px] text-zinc-500">SAVED</span>}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-4 min-w-0">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 rounded-lg bg-[#09090B] border border-white/[0.06]">
                    <ScoreBar label="Overall" value={active.score} /><ScoreBar label="Hook" value={active.hookScore} /><ScoreBar label="Visual" value={active.visualScore} /><ScoreBar label="Commentary" value={active.commentaryScore} />
                    <div className="col-span-full flex items-center gap-1.5 text-[10.5px] text-zinc-500"><Info className="w-3 h-3" /> Heuristic scores to help triage. They do not predict views or revenue.</div>
                  </div>
                  <div><label className="label-xs">Title</label><input value={draft.title} maxLength={160} onChange={(e) => set("title", e.target.value)} className={cn(field, "mt-1.5")} data-testid="input-title" /></div>
                  <div><label className="label-xs">Hook</label><input value={draft.hook} maxLength={500} onChange={(e) => set("hook", e.target.value)} className={cn(field, "mt-1.5")} data-testid="input-hook" /></div>
                  <div><label className="label-xs flex justify-between"><span>Commentary script</span><span className="mono">{draft.script.length}/10000</span></label><textarea value={draft.script} maxLength={10000} onChange={(e) => set("script", e.target.value)} rows={7} className={cn(field, "mt-1.5 h-auto py-2 leading-relaxed resize-y")} data-testid="input-script" /></div>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div><label className="label-xs">Hashtags</label><input value={draft.hashtags} maxLength={1000} onChange={(e) => set("hashtags", e.target.value)} className={cn(field, "mt-1.5 mono text-[12px]")} data-testid="input-hashtags" /></div>
                    <div><label className="label-xs">Campaign</label>
                      <select value={draft.campaignId ?? ""} onChange={(e) => set("campaignId", e.target.value ? Number(e.target.value) : null)} className={cn(field, "mt-1.5")} data-testid="select-clip-campaign">
                        <option value="">None</option>{campaigns.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select></div>
                  </div>
                  <div><label className="label-xs">Pinned comment</label><textarea value={draft.pinnedComment} maxLength={2000} onChange={(e) => set("pinnedComment", e.target.value)} rows={2} className={cn(field, "mt-1.5 h-auto py-2 resize-y")} data-testid="input-pinned" /></div>
                  {dirty && <div className="text-[11.5px] text-amber-400 mono">Unsaved changes</div>}
                </div>
              </div>
            </div>
          ) : <EmptyState icon={<Film className="w-4 h-4" />} title="Select a clip" desc="Choose a clip from the list to edit." />}
        </div>
      )}

      <Dialog open={!!exportRes} onOpenChange={(o) => !o && setExportRes(null)}>
        <DialogContent className="bg-[#121215] border-white/[0.08]">
          <DialogTitle className="text-[15px]">Export package ready</DialogTitle>
          <DialogDescription className="text-[12.5px]">{exportRes?.message}</DialogDescription>
          <div className="flex items-center gap-2 p-3 rounded-md bg-[#09090B] border border-white/[0.06]">
            <Download className="w-4 h-4 text-emerald-400" /><span className="mono text-[12px] truncate flex-1">{exportRes?.filename}</span>
            <Pill tone={exportRes?.includesVideo ? "emerald" : "amber"}>{exportRes?.includesVideo ? "Video included" : "Metadata only"}</Pill>
          </div>
          <div className="flex justify-end gap-2"><button className={btn.ghost} onClick={() => setExportRes(null)}>Close</button><a href={exportRes?.downloadUrl} download={exportRes?.filename} className={btn.primary} data-testid="link-download-export">Download</a></div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmDel} onOpenChange={(o) => !o && setConfirmDel(null)}>
        <DialogContent className="bg-[#121215] border-white/[0.08]">
          <DialogTitle className="text-[15px]">Delete clip?</DialogTitle>
          <DialogDescription className="text-[12.5px]">"{confirmDel?.title}" and its metadata will be removed permanently.</DialogDescription>
          <div className="flex justify-end gap-2"><button className={btn.ghost} onClick={() => setConfirmDel(null)}>Cancel</button><button className={btn.danger} disabled={del.isPending} onClick={() => confirmDel && del.mutate({ id: confirmDel.id })} data-testid="button-confirm-delete">Delete</button></div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
