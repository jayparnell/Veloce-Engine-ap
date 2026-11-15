import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@workspace/replit-auth-web";
import {
  useListCampaigns, getListCampaignsQueryKey, useCreateCampaign, useUpdateCampaign, useDeleteCampaign, useListClips, getListClipsQueryKey,
  getGetStudioSummaryQueryKey, type Campaign, type CampaignInput, type CampaignInputStatus,
} from "@workspace/api-client-react";
import { Plus, Pencil, Trash2, Copy, Coins, Check, Circle, Upload, ExternalLink } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useFileUpload } from "@/hooks/use-file-upload";
import { cn } from "@/lib/utils";
import { PageHeader, Pill, DemoTag, Sk, ErrorState, EmptyState, Stat, statusTone, errMsg, fmtMoney, fmtNum, btn, field } from "@/components/kit";

const blank: CampaignInput = { name: "", brand: "", cpm: 2.5, budget: 500, status: "active", affiliateUrl: "", cta: "" };

function AssetField({ label, accept, value, onChange }: { label: string; accept: string; value?: string; onChange: (v: string | undefined) => void }) {
  const { isAuthenticated } = useAuth();
  const { upload, uploading, error } = useFileUpload();
  return (
    <div>
      <div className="label-xs mb-1.5">{label}</div>
      <div className="flex items-center gap-2">
        <label className={cn(btn.ghost, "cursor-pointer", (!isAuthenticated || uploading) && "opacity-40 pointer-events-none")}>
          <Upload className="w-3.5 h-3.5" /> {uploading ? "Uploading..." : value ? "Replace" : "Upload"}
          <input type="file" accept={accept} className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) { const p = await upload(f); if (p) onChange(p); } }} />
        </label>
        {value && <button type="button" className={btn.icon} onClick={() => onChange(undefined)}><Trash2 className="w-3 h-3" /></button>}
        <span className="mono text-[10.5px] text-zinc-500 truncate">{value ?? (isAuthenticated ? "none" : "log in to upload")}</span>
      </div>
      {error && <div className="text-[11px] text-red-400 mt-1">{error}</div>}
    </div>
  );
}

function Readiness({ c, clipCount }: { c: Campaign; clipCount: number }) {
  const items = [
    { ok: c.status === "active", l: "Campaign is active" },
    { ok: /^https?:\/\//.test(c.affiliateUrl), l: "Affiliate URL set" },
    { ok: c.cta.trim().length > 0, l: "Call to action written" },
    { ok: clipCount > 0, l: `${clipCount} clip${clipCount === 1 ? "" : "s"} linked` },
    { ok: !!c.watermarkPath || !!c.audioPath, l: "Brand asset attached (optional)" },
  ];
  const score = items.filter((i) => i.ok).length;
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5"><span className="label-xs">Readiness</span><span className="mono text-[11px] text-zinc-400">{score}/{items.length}</span></div>
      <div className="space-y-1">{items.map((i) => (
        <div key={i.l} className="flex items-center gap-2 text-[11.5px]">{i.ok ? <Check className="w-3 h-3 text-emerald-400" /> : <Circle className="w-3 h-3 text-zinc-600" />}<span className={i.ok ? "text-zinc-300" : "text-zinc-500"}>{i.l}</span></div>))}</div>
    </div>
  );
}

export default function Monetization() {
  const qc = useQueryClient();
  const { toast } = useToast();
  useEffect(() => { document.title = "Monetization · Veloce Engine"; }, []);
  const list = useListCampaigns({ query: { queryKey: getListCampaignsQueryKey() } });
  const clips = useListClips({ query: { queryKey: getListClipsQueryKey() } });
  const [edit, setEdit] = useState<{ id?: number; v: CampaignInput } | null>(null);
  const [del, setDel] = useState<Campaign | null>(null);
  const inval = () => { qc.invalidateQueries({ queryKey: getListCampaignsQueryKey() }); qc.invalidateQueries({ queryKey: getGetStudioSummaryQueryKey() }); };
  const onErr = (e: unknown) => toast({ title: "Request failed", description: errMsg(e), variant: "destructive" });
  const create = useCreateCampaign({ mutation: { onSuccess: () => { inval(); setEdit(null); toast({ title: "Campaign created" }); }, onError: onErr } });
  const update = useUpdateCampaign({ mutation: { onSuccess: () => { inval(); setEdit(null); toast({ title: "Campaign updated" }); }, onError: onErr } });
  const remove = useDeleteCampaign({ mutation: { onSuccess: () => { inval(); qc.invalidateQueries({ queryKey: getListClipsQueryKey() }); setDel(null); toast({ title: "Campaign deleted" }); }, onError: onErr } });

  const data = list.data ?? [];
  const projected = data.reduce((a, c) => a + Math.min(c.budget, (c.views / 1000) * c.cpm), 0);
  const v = edit?.v;
  const setV = (p: Partial<CampaignInput>) => setEdit((e) => (e ? { ...e, v: { ...e.v, ...p } } : e));
  const valid = v && v.name.trim() && v.brand.trim() && v.cpm >= 0 && v.cpm <= 10000 && v.budget >= 0 && (!v.affiliateUrl || /^https?:\/\//.test(v.affiliateUrl));
  function save() {
    if (!edit || !valid) return;
    const data = { ...edit.v, cpm: Number(edit.v.cpm), budget: Number(edit.v.budget) };
    edit.id ? update.mutate({ id: edit.id, data }) : create.mutate({ data });
  }

  return (
    <div>
      <PageHeader eyebrow="03 / Monetization" title="Bounty Campaigns" desc="Track CPM bounties, affiliate links and projected payouts. Projections are arithmetic on reported views, not promised earnings."
        actions={<button className={btn.primary} onClick={() => setEdit({ v: { ...blank } })} data-testid="button-new-campaign"><Plus className="w-3.5 h-3.5" /> New campaign</button>} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {list.isLoading ? [0, 1, 2, 3].map((i) => <Sk key={i} className="h-[84px]" />) : <>
          <Stat label="Campaigns" value={data.length} sub={`${data.filter((c) => c.status === "active").length} active`} />
          <Stat label="Reported views" value={fmtNum(data.reduce((a, c) => a + c.views, 0))} />
          <Stat label="Recorded payout" value={fmtMoney(data.reduce((a, c) => a + c.payout, 0))} accent="emerald" />
          <Stat label="Projected (capped)" value={fmtMoney(projected)} sub="views / 1k x CPM, capped at budget" accent="amber" />
        </>}
      </div>

      {list.isLoading ? <div className="grid md:grid-cols-2 gap-3">{[0, 1].map((i) => <Sk key={i} className="h-64" />)}</div>
        : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} />
        : !data.length ? <EmptyState icon={<Coins className="w-4 h-4" />} title="No campaigns" desc="Add a bounty campaign to attach affiliate CTAs to bounty-mode clips." action={<button className={btn.primary} onClick={() => setEdit({ v: { ...blank } })}>New campaign</button>} />
        : <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
          {data.map((c) => {
            const proj = Math.min(c.budget, (c.views / 1000) * c.cpm);
            const used = c.budget ? Math.min(100, (proj / c.budget) * 100) : 0;
            const linked = clips.data?.filter((k) => k.campaignId === c.id).length ?? 0;
            return (
              <div key={c.id} className="panel p-4 flex flex-col gap-4 rise" data-testid={`card-campaign-${c.id}`}>
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap"><span className="text-[14px] font-medium truncate">{c.name}</span>{c.demo && <DemoTag />}</div>
                    <div className="text-[12px] text-muted-foreground">{c.brand}</div>
                  </div>
                  <Pill tone={statusTone(c.status)}>{c.status}</Pill>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div><div className="label-xs">CPM</div><div className="mono text-[14px] mt-0.5">{fmtMoney(c.cpm)}</div></div>
                  <div><div className="label-xs">Views</div><div className="mono text-[14px] mt-0.5">{fmtNum(c.views)}</div></div>
                  <div><div className="label-xs">Projected</div><div className="mono text-[14px] mt-0.5 text-amber-400">{fmtMoney(proj)}</div></div>
                </div>
                <div>
                  <div className="flex justify-between mono text-[10.5px] text-zinc-500 mb-1"><span>budget {fmtMoney(c.budget)}</span><span>{used.toFixed(1)}%</span></div>
                  <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden"><div className="h-full bg-amber-500" style={{ width: `${used}%` }} /></div>
                </div>
                {c.affiliateUrl ? (
                  <div className="flex items-center gap-1 p-1.5 pl-2.5 rounded-md bg-[#09090B] border border-white/[0.06]">
                    <span className="mono text-[11px] text-zinc-400 truncate flex-1">{c.affiliateUrl}</span>
                    <button className={btn.icon} onClick={() => { navigator.clipboard.writeText(c.affiliateUrl); toast({ title: "Affiliate URL copied" }); }} data-testid={`button-copy-${c.id}`}><Copy className="w-3 h-3" /></button>
                    <a className={btn.icon} href={c.affiliateUrl} target="_blank" rel="noreferrer"><ExternalLink className="w-3 h-3" /></a>
                  </div>
                ) : <div className="text-[11.5px] text-amber-400/80">No affiliate URL yet</div>}
                {c.cta && <div className="text-[12px] text-zinc-300 border-l-2 border-emerald-500/50 pl-2.5">{c.cta}</div>}
                <Readiness c={c} clipCount={linked} />
                <div className="flex gap-2 mt-auto pt-1">
                  <button className={cn(btn.ghost, "flex-1")} onClick={() => setEdit({ id: c.id, v: { name: c.name, brand: c.brand, cpm: c.cpm, budget: c.budget, status: c.status, affiliateUrl: c.affiliateUrl, cta: c.cta, audioPath: c.audioPath, watermarkPath: c.watermarkPath } })} data-testid={`button-edit-${c.id}`}><Pencil className="w-3.5 h-3.5" /> Edit</button>
                  <button className={btn.danger} onClick={() => setDel(c)} data-testid={`button-delete-${c.id}`}><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </div>
            );
          })}
        </div>}

      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent className="bg-[#121215] border-white/[0.08] max-w-lg max-h-[90dvh] overflow-y-auto">
          <DialogTitle className="text-[15px]">{edit?.id ? "Edit campaign" : "New campaign"}</DialogTitle>
          <DialogDescription className="text-[12px]">Bounty terms as published by the brand.</DialogDescription>
          {v && <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div><div className="label-xs mb-1.5">Name</div><input className={field} value={v.name} maxLength={160} onChange={(e) => setV({ name: e.target.value })} data-testid="input-campaign-name" /></div>
              <div><div className="label-xs mb-1.5">Brand</div><input className={field} value={v.brand} maxLength={100} onChange={(e) => setV({ brand: e.target.value })} data-testid="input-campaign-brand" /></div>
              <div><div className="label-xs mb-1.5">CPM (USD)</div><input type="number" step="0.01" min={0} max={10000} className={cn(field, "mono")} value={v.cpm} onChange={(e) => setV({ cpm: Number(e.target.value) })} data-testid="input-campaign-cpm" /></div>
              <div><div className="label-xs mb-1.5">Budget (USD)</div><input type="number" min={0} className={cn(field, "mono")} value={v.budget} onChange={(e) => setV({ budget: Number(e.target.value) })} data-testid="input-campaign-budget" /></div>
            </div>
            <div><div className="label-xs mb-1.5">Status</div>
              <div className="inline-flex rounded-md border border-white/[0.08] p-0.5 bg-[#09090B]">{(["active", "paused", "completed"] as CampaignInputStatus[]).map((s) => <button key={s} type="button" onClick={() => setV({ status: s })} className={cn("px-3 h-7 rounded text-[12px] capitalize", v.status === s ? "bg-white/[0.09]" : "text-zinc-500")}>{s}</button>)}</div></div>
            <div><div className="label-xs mb-1.5">Affiliate URL</div><input className={cn(field, "mono text-[12px]")} placeholder="https://" value={v.affiliateUrl} maxLength={2048} onChange={(e) => setV({ affiliateUrl: e.target.value })} data-testid="input-campaign-url" /></div>
            <div><div className="label-xs mb-1.5">Call to action</div><textarea rows={2} className={cn(field, "h-auto py-2")} value={v.cta} maxLength={500} onChange={(e) => setV({ cta: e.target.value })} data-testid="input-campaign-cta" /></div>
            <div className="grid sm:grid-cols-2 gap-3">
              <AssetField label="Audio bed" accept="audio/*" value={v.audioPath} onChange={(p) => setV({ audioPath: p })} />
              <AssetField label="Watermark (PNG)" accept="image/png" value={v.watermarkPath} onChange={(p) => setV({ watermarkPath: p })} />
            </div>
            <div className="text-[11.5px] text-zinc-500 mono">Est. payout per 100k views: {fmtMoney(100 * (Number(v.cpm) || 0))}</div>
            <div className="flex justify-end gap-2 pt-1"><button className={btn.ghost} onClick={() => setEdit(null)}>Cancel</button><button className={btn.primary} disabled={!valid || create.isPending || update.isPending} onClick={save} data-testid="button-save-campaign">Save</button></div>
          </div>}
        </DialogContent>
      </Dialog>

      <Dialog open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <DialogContent className="bg-[#121215] border-white/[0.08]">
          <DialogTitle className="text-[15px]">Delete campaign?</DialogTitle>
          <DialogDescription className="text-[12.5px]">"{del?.name}" will be removed. Linked clips keep their content but lose the campaign link.</DialogDescription>
          <div className="flex justify-end gap-2"><button className={btn.ghost} onClick={() => setDel(null)}>Cancel</button><button className={btn.danger} disabled={remove.isPending} onClick={() => del && remove.mutate({ id: del.id })} data-testid="button-confirm-delete-campaign">Delete</button></div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
