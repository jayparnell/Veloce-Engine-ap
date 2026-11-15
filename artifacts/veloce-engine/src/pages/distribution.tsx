import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListSchedules, getListSchedulesQueryKey, useCreateSchedule, useDeleteSchedule, useListPlatformAccounts, getListPlatformAccountsQueryKey,
  useListClips, getListClipsQueryKey, type ScheduleInputPlatform,
} from "@workspace/api-client-react";
import { SiYoutube, SiTiktok, SiInstagram, SiX } from "react-icons/si";
import { Plus, Trash2, CalendarClock, PlugZap, Info } from "lucide-react";
import { format } from "date-fns";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { PageHeader, Pill, DemoTag, Sk, ErrorState, EmptyState, statusTone, errMsg, btn, field } from "@/components/kit";

const PLATFORMS: ScheduleInputPlatform[] = ["YouTube Shorts", "TikTok", "Instagram Reels", "X"];
export function PlatformIcon({ p, className }: { p: string; className?: string }) {
  const x = p.toLowerCase();
  const I = x.includes("youtube") ? SiYoutube : x.includes("tiktok") ? SiTiktok : x.includes("instagram") ? SiInstagram : SiX;
  return <I className={className} />;
}

export default function Distribution() {
  const qc = useQueryClient();
  const { toast } = useToast();
  useEffect(() => { document.title = "Distribution · Veloce Engine"; }, []);
  const schedules = useListSchedules({ query: { queryKey: getListSchedulesQueryKey() } });
  const accounts = useListPlatformAccounts({ query: { queryKey: getListPlatformAccountsQueryKey() } });
  const clips = useListClips({ query: { queryKey: getListClipsQueryKey() } });
  const [open, setOpen] = useState(false);
  const [clipId, setClipId] = useState("");
  const [platform, setPlatform] = useState<ScheduleInputPlatform>("YouTube Shorts");
  const [when, setWhen] = useState("");
  const [filter, setFilter] = useState("all");

  const create = useCreateSchedule({ mutation: { onSuccess: () => { qc.invalidateQueries({ queryKey: getListSchedulesQueryKey() }); setOpen(false); setClipId(""); setWhen(""); toast({ title: "Draft added", description: "Planning only. Nothing is published automatically." }); }, onError: (e) => toast({ title: "Could not create draft", description: errMsg(e), variant: "destructive" }) } });
  const del = useDeleteSchedule({ mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListSchedulesQueryKey() }), onError: (e) => toast({ title: "Delete failed", description: errMsg(e), variant: "destructive" }) } });

  const sorted = useMemo(() => [...(schedules.data ?? [])].filter((s) => filter === "all" || s.platform === filter).sort((a, b) => +new Date(a.scheduledAt) - +new Date(b.scheduledAt)), [schedules.data, filter]);
  const groups = useMemo(() => {
    const m = new Map<string, typeof sorted>();
    sorted.forEach((s) => { const k = format(new Date(s.scheduledAt), "yyyy-MM-dd"); m.set(k, [...(m.get(k) ?? []), s]); });
    return [...m.entries()];
  }, [sorted]);

  return (
    <div>
      <PageHeader eyebrow="04 / Distribution" title="Publishing Drafts" desc="Plan multi-platform releases. Drafts are a planning calendar; direct publishing is not connected yet, so you post manually from your exports."
        actions={<button className={btn.primary} onClick={() => setOpen(true)} data-testid="button-new-schedule"><Plus className="w-3.5 h-3.5" /> New draft</button>} />

      <div className="grid lg:grid-cols-[1fr_300px] gap-5">
        <div className="min-w-0">
          <div className="flex gap-1 mb-3 overflow-x-auto">
            {["all", ...PLATFORMS].map((p) => <button key={p} onClick={() => setFilter(p)} className={cn("h-7 px-2.5 rounded-md text-[12px] whitespace-nowrap flex items-center gap-1.5 transition", filter === p ? "bg-white/[0.08]" : "text-zinc-500 hover:text-zinc-300")}>{p !== "all" && <PlatformIcon p={p} className="w-3 h-3" />}{p === "all" ? "All" : p}</button>)}
          </div>
          {schedules.isLoading ? <div className="space-y-2">{[0, 1, 2].map((i) => <Sk key={i} className="h-14" />)}</div>
            : schedules.isError ? <ErrorState error={schedules.error} onRetry={() => schedules.refetch()} />
            : !sorted.length ? <EmptyState icon={<CalendarClock className="w-4 h-4" />} title="No drafts planned" desc="Pick a clip, a platform and a target time to build your release calendar." action={<button className={btn.primary} onClick={() => setOpen(true)}>New draft</button>} />
            : <div className="space-y-4">{groups.map(([day, items]) => (
              <div key={day}>
                <div className="mono text-[11px] text-zinc-500 mb-1.5 uppercase tracking-wider">{format(new Date(day + "T00:00"), "EEE, MMM d")}</div>
                <div className="panel">{items.map((s) => (
                  <div key={s.id} className="flex items-center gap-3 px-3.5 py-2.5 border-b border-white/[0.05] last:border-0" data-testid={`row-schedule-${s.id}`}>
                    <span className="mono text-[12px] text-zinc-400 w-12 tabular-nums">{format(new Date(s.scheduledAt), "HH:mm")}</span>
                    <div className="w-7 h-7 rounded-md bg-white/[0.04] border border-white/[0.06] flex items-center justify-center"><PlatformIcon p={s.platform} className="w-3.5 h-3.5 text-zinc-300" /></div>
                    <div className="flex-1 min-w-0"><div className="text-[13px] truncate">{s.title}</div><div className="text-[11px] text-muted-foreground">{s.platform} · clip #{s.clipId}</div></div>
                    {s.demo && <DemoTag />}
                    <Pill tone={statusTone(s.status)}>{s.status}</Pill>
                    <button className={btn.icon} disabled={del.isPending} onClick={() => del.mutate({ id: s.id })} data-testid={`button-delete-schedule-${s.id}`}><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>))}</div>
              </div>))}</div>}
        </div>

        <div>
          <h2 className="text-[13px] font-semibold mb-2.5">Platform connections</h2>
          {accounts.isLoading ? <Sk className="h-48" /> : accounts.isError ? <ErrorState error={accounts.error} onRetry={() => accounts.refetch()} /> : (
            <div className="panel">
              {accounts.data?.map((a) => (
                <div key={a.id} className="px-3.5 py-3 border-b border-white/[0.05] last:border-0" data-testid={`row-account-${a.id}`}>
                  <div className="flex items-center gap-2.5">
                    <PlatformIcon p={a.platform} className="w-4 h-4 text-zinc-300" />
                    <span className="text-[13px] flex-1">{a.platform}</span>
                    <Pill tone={a.connected ? "emerald" : "neutral"}>{a.connected ? "Connected" : "Not connected"}</Pill>
                  </div>
                  {a.handle && <div className="mono text-[11px] text-zinc-500 mt-1 ml-6">{a.handle}</div>}
                  <div className="text-[11.5px] text-muted-foreground mt-1 ml-6">{a.message}</div>
                  <button disabled className={cn(btn.ghost, "mt-2 ml-6 h-7")} title="OAuth publishing is not available yet"><PlugZap className="w-3 h-3" /> Connect (coming later)</button>
                </div>))}
              {!accounts.data?.length && <div className="p-4 text-[12px] text-muted-foreground">No integrations reported.</div>}
            </div>)}
          <div className="mt-3 flex gap-2 text-[11.5px] text-zinc-500 p-3 rounded-lg border border-dashed border-white/[0.08]"><Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />Status reflects the integration state reported by the server. Nothing is posted on your behalf.</div>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-[#121215] border-white/[0.08]">
          <DialogTitle className="text-[15px]">New publishing draft</DialogTitle>
          <DialogDescription className="text-[12px]">A planning entry. You will still post manually.</DialogDescription>
          <div className="space-y-3">
            <div><div className="label-xs mb-1.5">Clip</div>
              <select className={field} value={clipId} onChange={(e) => setClipId(e.target.value)} data-testid="select-schedule-clip">
                <option value="">{clips.isLoading ? "Loading clips..." : "Select a clip"}</option>
                {clips.data?.map((c) => <option key={c.id} value={c.id}>#{c.id} {c.title}</option>)}
              </select></div>
            <div><div className="label-xs mb-1.5">Platform</div>
              <div className="grid grid-cols-2 gap-1.5">{PLATFORMS.map((p) => <button key={p} type="button" onClick={() => setPlatform(p)} className={cn("h-9 rounded-md border text-[12px] flex items-center justify-center gap-1.5 transition", platform === p ? "border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-300" : "border-white/[0.08] text-zinc-400")} data-testid={`button-platform-${p}`}><PlatformIcon p={p} className="w-3.5 h-3.5" />{p}</button>)}</div></div>
            <div><div className="label-xs mb-1.5">Target time</div><input type="datetime-local" className={cn(field, "mono [color-scheme:dark]")} value={when} onChange={(e) => setWhen(e.target.value)} data-testid="input-schedule-time" /></div>
            <div className="flex justify-end gap-2 pt-1"><button className={btn.ghost} onClick={() => setOpen(false)}>Cancel</button>
              <button className={btn.primary} disabled={!clipId || !when || create.isPending} onClick={() => create.mutate({ data: { clipId: Number(clipId), platform, scheduledAt: new Date(when).toISOString() } })} data-testid="button-save-schedule">Add draft</button></div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
