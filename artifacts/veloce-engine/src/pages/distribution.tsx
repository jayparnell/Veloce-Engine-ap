import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListSchedules, getListSchedulesQueryKey, useCreateSchedule, useDeleteSchedule, useListClips, getListClipsQueryKey,
  useGetAutopilotAccounts, getGetAutopilotAccountsQueryKey, useUpdateAutopilotAccount, useDisconnectAutopilotAccount,
  useGetAutopilotSchedule, getGetAutopilotScheduleQueryKey, useGetSocialIntegrations, getGetSocialIntegrationsQueryKey,
  type ScheduleInputPlatform, type AutopilotAccount, type SlotPreset, type SocialIntegration,
} from "@workspace/api-client-react";
import { SiYoutube, SiTiktok, SiInstagram, SiX } from "react-icons/si";
import { Plus, Trash2, CalendarClock, Info, ExternalLink, Unplug, Save, X, AlertTriangle } from "lucide-react";
import { format } from "date-fns";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { TikTokReviewDialog } from "@/components/tiktok-review";
import { RenderBudgetSettings, FailureDetails } from "@/components/autopilot";
import { PageHeader, Pill, DemoTag, Sk, ErrorState, EmptyState, statusTone, errMsg, btn, field } from "@/components/kit";

const PLATFORMS: ScheduleInputPlatform[] = ["YouTube Shorts", "TikTok", "Instagram Reels", "X"];
const PROVIDERS = [{ id: "youtube", label: "YouTube Shorts" }, { id: "tiktok", label: "TikTok" }, { id: "instagram", label: "Instagram Reels" }, { id: "x", label: "X" }] as const;
const TZ = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Sao_Paulo", "America/Mexico_City", "Europe/London", "Europe/Madrid", "Europe/Lisbon", "Europe/Berlin", "Asia/Tokyo", "Asia/Singapore", "Australia/Sydney", "UTC"];
const SLOT_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const validTz = (z: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: z }); return !!z; } catch { return false; } };

export function PlatformIcon({ p, className }: { p: string; className?: string }) {
  const x = p.toLowerCase();
  const I = x.includes("youtube") ? SiYoutube : x.includes("tiktok") ? SiTiktok : x.includes("instagram") ? SiInstagram : SiX;
  return <I className={className} />;
}

function AccountEditor({ a, presets }: { a: AutopilotAccount; presets: SlotPreset[] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [autoEnabled, setAuto] = useState(a.autoEnabled);
  const [includeDubs, setDubs] = useState(a.includeDubs);
  const [timezone, setTz] = useState(a.timezone || "America/New_York");
  const [slots, setSlots] = useState<string[]>(a.slots);
  const [slotIn, setSlotIn] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);
  useEffect(() => { setAuto(a.autoEnabled); setDubs(a.includeDubs); setTz(a.timezone || "America/New_York"); setSlots(a.slots); }, [a.id, a.autoEnabled, a.includeDubs, a.timezone, a.slots.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => { qc.invalidateQueries({ queryKey: getGetAutopilotAccountsQueryKey() }); qc.invalidateQueries({ queryKey: getGetAutopilotScheduleQueryKey() }); };
  const upd = useUpdateAutopilotAccount({ mutation: { onSuccess: () => { refresh(); toast({ title: "Account preferences saved", description: autoEnabled ? "Auto-posting is on for this account. New ready clips will be queued into your slots." : "Auto-posting is off for this account." }); }, onError: (e) => toast({ title: "Save failed", description: errMsg(e), variant: "destructive" }) } });
  const disc = useDisconnectAutopilotAccount({ mutation: { onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: getGetSocialIntegrationsQueryKey() }); setConfirmOff(false); toast({ title: "Account disconnected", description: "Tokens for this account were removed. Revoke access on the platform too if needed." }); }, onError: (e) => toast({ title: "Disconnect failed", description: errMsg(e), variant: "destructive" }) } });
  const preset = presets.find((p) => p.provider === a.provider || p.platform === a.platform);
  const blockers = [!a.connected && "Not connected", !a.approved && "Provider app approval pending"].filter(Boolean) as string[];
  const dirty = autoEnabled !== a.autoEnabled || includeDubs !== a.includeDubs || timezone !== a.timezone || slots.join(",") !== a.slots.join(",");
  const tzOk = validTz(timezone);
  const addSlot = () => { const s = slotIn.trim(); if (SLOT_RE.test(s) && !slots.includes(s) && slots.length < 12) { setSlots([...slots, s].sort()); setSlotIn(""); } };
  return (
    <div className="px-4 py-4 border-b border-white/[0.05] last:border-0" data-testid={`row-autopilot-account-${a.id}`}>
      <div className="flex items-center gap-2.5 flex-wrap">
        <PlatformIcon p={a.platform} className="w-4 h-4 text-zinc-300" />
        <span className="text-[13px] font-medium mono" data-testid={`text-handle-${a.id}`}>{a.handle || "(no handle reported)"}</span>
        <Pill tone={a.connected ? "emerald" : "neutral"}>{a.connected ? "Connected" : "Not connected"}</Pill>
        <Pill tone={a.approved ? "emerald" : "amber"}>{a.approved ? "Provider approved" : "Approval pending"}</Pill>
        {a.autoEnabled && a.connected && a.approved && <Pill tone="sky" dot>Auto on</Pill>}
        <button className={cn(btn.icon, "ml-auto")} onClick={() => setConfirmOff(true)} aria-label="Disconnect account" data-testid={`button-disconnect-account-${a.id}`}><Unplug className="w-3.5 h-3.5" /></button>
      </div>
      {a.message && <p className="text-[11.5px] text-muted-foreground mt-1.5">{a.message}</p>}
      {blockers.length > 0 && <div className="mt-2 flex items-start gap-2 text-[11.5px] text-amber-300 bg-amber-500/5 border border-amber-500/15 rounded-md px-2.5 py-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>Setup blockers: {blockers.join(" · ")}. Nothing will publish to this account until resolved in <Link href="/settings" className="underline">Settings</Link>.</span></div>}

      <div className="mt-3 grid sm:grid-cols-2 gap-3">
        <label className="flex items-start gap-2.5 p-2.5 rounded-md border border-white/[0.07] bg-[#09090B] cursor-pointer">
          <input type="checkbox" checked={autoEnabled} onChange={(e) => setAuto(e.target.checked)} className="accent-emerald-500 mt-0.5 w-4 h-4" data-testid={`checkbox-auto-${a.id}`} />
          <span className="text-[12px]"><span className="font-medium block">Auto-publish to this account</span><span className="text-zinc-500">Off by default. Only clips finished after enabling receive slots; your historical vault is not backfilled. TikTok also requires per-video review.</span></span>
        </label>
        <label className="flex items-start gap-2.5 p-2.5 rounded-md border border-white/[0.07] bg-[#09090B] cursor-pointer">
          <input type="checkbox" checked={includeDubs} onChange={(e) => setDubs(e.target.checked)} className="accent-emerald-500 mt-0.5 w-4 h-4" data-testid={`checkbox-dubs-${a.id}`} />
          <span className="text-[12px]"><span className="font-medium block">Include ES / PT dubs</span><span className="text-zinc-500">Also queue dubbed variants, not only originals.</span></span>
        </label>
      </div>
      <div className="mt-3 grid sm:grid-cols-[220px_1fr] gap-3">
        <div>
          <div className="label-xs mb-1.5">Timezone (IANA)</div>
          <input list={`tz-${a.id}`} value={timezone} onChange={(e) => setTz(e.target.value)} className={cn(field, "mono text-[16px] sm:text-[12.5px]", !tzOk && "border-amber-500/50")} autoCapitalize="off" autoCorrect="off" data-testid={`input-timezone-${a.id}`} />
          <datalist id={`tz-${a.id}`}>{TZ.map((z) => <option key={z} value={z} />)}</datalist>
          {!tzOk && <div className="mono text-[10.5px] text-amber-400 mt-1">Not a recognized IANA zone</div>}
        </div>
        <div>
          <div className="label-xs mb-1.5 flex justify-between"><span>Posting slots</span>{preset && <button type="button" className="text-emerald-400 normal-case tracking-normal" onClick={() => setSlots([...preset.slots])} data-testid={`button-preset-${a.id}`}>Apply {preset.platform} preset</button>}</div>
          <div className="flex flex-wrap gap-1.5 items-center">
            {slots.map((s) => <span key={s} className="inline-flex items-center gap-1 h-7 pl-2 pr-1 rounded-md border border-white/[0.08] mono text-[12px]">{s}<button type="button" className="w-5 h-5 inline-flex items-center justify-center text-zinc-500 hover:text-zinc-200" onClick={() => setSlots(slots.filter((x) => x !== s))} aria-label={`Remove ${s}`}><X className="w-3 h-3" /></button></span>)}
            <input type="time" value={slotIn} onChange={(e) => setSlotIn(e.target.value)} className={cn(field, "w-[110px] h-7 mono text-[16px] sm:text-[12px] [color-scheme:dark]")} data-testid={`input-slot-${a.id}`} />
            <button type="button" className={cn(btn.ghost, "h-7")} disabled={!SLOT_RE.test(slotIn) || slots.length >= 12} onClick={addSlot}><Plus className="w-3 h-3" />Add</button>
          </div>
          <div className="text-[10.5px] text-zinc-500 mt-1">Presets are starting points, not peak-engagement claims. 1 to 12 slots.</div>
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <button className={btn.primary} disabled={!dirty || !tzOk || !slots.length || upd.isPending} onClick={() => upd.mutate({ id: a.id, data: { autoEnabled, includeDubs, timezone, slots } })} data-testid={`button-save-account-${a.id}`}><Save className="w-3.5 h-3.5" />{upd.isPending ? "Saving..." : "Save preferences"}</button>
      </div>

      <Dialog open={confirmOff} onOpenChange={setConfirmOff}>
        <DialogContent className="bg-[#121215] border-white/[0.08] max-w-[calc(100vw-24px)] sm:max-w-md">
          <DialogTitle className="text-[15px]">Disconnect {a.handle || a.platform}?</DialogTitle>
          <DialogDescription className="text-[12.5px]">Stored tokens for this one account are removed and its pending auto-posts stop. Other accounts on {a.platform} are unaffected. Published videos are not deleted.</DialogDescription>
          <div className="flex justify-end gap-2"><button className={btn.ghost} onClick={() => setConfirmOff(false)}>Cancel</button><button className={btn.danger} disabled={disc.isPending} onClick={() => disc.mutate({ id: a.id })} data-testid={`button-confirm-disconnect-${a.id}`}>Disconnect</button></div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProviderGroup({ provider, label, accounts, presets, integration }: { provider: string; label: string; accounts: AutopilotAccount[]; presets: SlotPreset[]; integration?: SocialIntegration }) {
  const preset = presets.find((p) => p.provider === provider);
  const timeLabel = (value: string) => {
    const [hour, minute] = value.split(":").map(Number);
    return `${hour! % 12 || 12}:${String(minute).padStart(2, "0")} ${hour! < 12 ? "AM" : "PM"}`;
  };
  return (
    <div className="panel overflow-hidden" data-testid={`group-provider-${provider}`}>
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/[0.06] bg-white/[0.012]">
        <PlatformIcon p={provider} className="w-4 h-4" />
        <span className="text-[13px] font-semibold flex-1">{label}</span>
        <span className="mono text-[11px] text-zinc-500">{accounts.length} account{accounts.length === 1 ? "" : "s"}</span>
        {integration?.canConnect
          ? <a href={`/api/social/oauth/${provider}/start`} className={cn(btn.ghost, "h-7")} data-testid={`button-authorize-${provider}`}><ExternalLink className="w-3 h-3" />{accounts.length ? "Add account" : "Authorize"}</a>
          : <Link href="/settings" className="text-[11.5px] text-amber-400" data-testid={`link-setup-${provider}`}>Setup required</Link>}
      </div>
      {preset && <div className="px-4 py-2 border-b border-white/[0.06] text-[11.5px] text-zinc-400" data-testid={`preset-summary-${provider}`}>
        <span className="text-zinc-300">Configurable preset · America/New_York:</span> {preset.slots.map(timeLabel).join(" · ")}
        <span className="block text-zinc-500 mt-0.5">Change slots and timezone per authorized account. These are starting presets, not peak-performance claims.</span>
      </div>}
      {accounts.length ? accounts.map((a) => <AccountEditor key={a.id} a={a} presets={presets} />)
        : <div className="px-4 py-4 text-[12px] text-zinc-500">No authorized accounts. {integration?.canConnect ? "Authorize one to enable auto-posting." : integration?.message || "Finish provider configuration in Settings first."}</div>}
    </div>
  );
}

function ManualDrafts() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const schedules = useListSchedules({ query: { queryKey: getListSchedulesQueryKey() } });
  const clips = useListClips({ query: { queryKey: getListClipsQueryKey() } });
  const [open, setOpen] = useState(false);
  const [clipId, setClipId] = useState("");
  const [platform, setPlatform] = useState<ScheduleInputPlatform>("YouTube Shorts");
  const [when, setWhen] = useState("");
  const create = useCreateSchedule({ mutation: { onSuccess: () => { qc.invalidateQueries({ queryKey: getListSchedulesQueryKey() }); setOpen(false); setClipId(""); setWhen(""); toast({ title: "Draft added", description: "Planning only. Drafts are never published automatically." }); }, onError: (e) => toast({ title: "Could not create draft", description: errMsg(e), variant: "destructive" }) } });
  const del = useDeleteSchedule({ mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListSchedulesQueryKey() }), onError: (e) => toast({ title: "Delete failed", description: errMsg(e), variant: "destructive" }) } });
  const sorted = useMemo(() => [...(schedules.data ?? [])].sort((a, b) => +new Date(a.scheduledAt) - +new Date(b.scheduledAt)), [schedules.data]);
  return (
    <section className="mt-10 pt-6 border-t border-dashed border-white/[0.1]">
      <div className="flex items-end justify-between gap-3 mb-3">
        <div><div className="label-xs mono">Separate from autopilot</div><h2 className="text-[14px] font-semibold mt-1">Manual planning drafts</h2><p className="text-[12px] text-muted-foreground">A private calendar for posts you make yourself. Nothing here is published.</p></div>
        <button className={btn.ghost} onClick={() => setOpen(true)} data-testid="button-new-schedule"><Plus className="w-3.5 h-3.5" />New draft</button>
      </div>
      {schedules.isLoading ? <Sk className="h-24" /> : schedules.isError ? <ErrorState error={schedules.error} onRetry={() => schedules.refetch()} />
        : !sorted.length ? <div className="panel px-4 py-5 text-[12px] text-zinc-500">No manual drafts.</div>
        : <div className="panel">{sorted.map((s) => (
          <div key={s.id} className="flex items-center gap-3 px-3.5 py-2.5 border-b border-white/[0.05] last:border-0" data-testid={`row-schedule-${s.id}`}>
            <span className="mono text-[11.5px] text-zinc-400 w-[92px] shrink-0 tabular-nums">{format(new Date(s.scheduledAt), "MMM d HH:mm")}</span>
            <PlatformIcon p={s.platform} className="w-3.5 h-3.5 text-zinc-300 shrink-0" />
            <div className="flex-1 min-w-0"><div className="text-[12.5px] truncate">{s.title}</div><div className="text-[11px] text-muted-foreground">{s.platform} · clip #{s.clipId}</div></div>
            {s.demo && <DemoTag />}
            <Pill tone={statusTone(s.status)}>{s.status}</Pill>
            <button className={btn.icon} disabled={del.isPending} onClick={() => del.mutate({ id: s.id })} aria-label="Delete draft" data-testid={`button-delete-schedule-${s.id}`}><Trash2 className="w-3.5 h-3.5" /></button>
          </div>))}</div>}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-[#121215] border-white/[0.08] max-w-[calc(100vw-24px)] sm:max-w-md">
          <DialogTitle className="text-[15px]">New planning draft</DialogTitle>
          <DialogDescription className="text-[12px]">A planning entry only. You will post manually.</DialogDescription>
          <div className="space-y-3">
            <select className={cn(field, "text-[16px] sm:text-[13px]")} value={clipId} onChange={(e) => setClipId(e.target.value)} data-testid="select-schedule-clip">
              <option value="">{clips.isLoading ? "Loading clips..." : "Select a clip"}</option>
              {clips.data?.map((c) => <option key={c.id} value={c.id}>#{c.id} {c.title}{c.language && c.language !== "en" ? ` (${c.language.toUpperCase()})` : ""}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-1.5">{PLATFORMS.map((p) => <button key={p} type="button" onClick={() => setPlatform(p)} className={cn("h-9 rounded-md border text-[12px] flex items-center justify-center gap-1.5 transition", platform === p ? "border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-300" : "border-white/[0.08] text-zinc-400")} data-testid={`button-platform-${p}`}><PlatformIcon p={p} className="w-3.5 h-3.5" />{p}</button>)}</div>
            <input type="datetime-local" className={cn(field, "mono [color-scheme:dark] text-[16px] sm:text-[13px]")} value={when} onChange={(e) => setWhen(e.target.value)} data-testid="input-schedule-time" />
            <div className="flex justify-end gap-2"><button className={btn.ghost} onClick={() => setOpen(false)}>Cancel</button>
              <button className={btn.primary} disabled={!clipId || !when || create.isPending} onClick={() => create.mutate({ data: { clipId: Number(clipId), platform, scheduledAt: new Date(when).toISOString() } })} data-testid="button-save-schedule">Add draft</button></div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export default function Distribution() {
  useEffect(() => { document.title = "Autopilot Schedule & Accounts · Veloce Engine"; }, []);
  const accounts = useGetAutopilotAccounts({ query: { queryKey: getGetAutopilotAccountsQueryKey(), refetchOnWindowFocus: true } });
  const sched = useGetAutopilotSchedule({ query: { queryKey: getGetAutopilotScheduleQueryKey(), refetchInterval: 10000, refetchOnWindowFocus: true, refetchOnReconnect: true } });
  const integrations = useGetSocialIntegrations({ query: { queryKey: getGetSocialIntegrationsQueryKey(), refetchOnWindowFocus: true } });
  const [filter, setFilter] = useState("all");
  const [reviewId, setReviewId] = useState<number | null>(null);
  const presets = sched.data?.presets ?? [];
  const entries = useMemo(() => [...(sched.data?.entries ?? [])].filter((e) => filter === "all" || e.status.toLowerCase() === filter).sort((a, b) => +new Date(a.scheduledAt) - +new Date(b.scheduledAt)), [sched.data, filter]);
  const statuses = useMemo(() => [...new Set((sched.data?.entries ?? []).map((e) => e.status.toLowerCase()))], [sched.data]);
  const fmtIn = (iso: string, tz: string) => { try { return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)); } catch { return format(new Date(iso), "MMM d HH:mm"); } };

  return (
    <div>
      <PageHeader eyebrow="04 / Distribution" title="Autopilot Schedule & Accounts" desc="Connect several authorized accounts per platform, opt each into auto-publishing, and see what the publisher actually did, including remote IDs and errors." />

      {sched.data && (
        <div className="panel px-4 py-3 mb-5 flex flex-wrap items-center gap-2 text-[12px]" data-testid="status-services">
          <Pill tone={sched.data.workerRunning ? "emerald" : "amber"} dot={sched.data.workerRunning}>Render worker {sched.data.workerRunning ? "running" : "stopped"}</Pill>
          <Pill tone={sched.data.publisherRunning ? "emerald" : "amber"} dot={sched.data.publisherRunning}>Publisher {sched.data.publisherRunning ? "running" : "stopped"}</Pill>
          {sched.data.serviceMessage && <span className="text-zinc-400">{sched.data.serviceMessage}</span>}
        </div>
      )}

      <RenderBudgetSettings />
      <div className="grid xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-5">
        <section className="space-y-3 min-w-0">
          <h2 className="text-[13px] font-semibold">Accounts</h2>
          {accounts.isLoading || integrations.isLoading ? <div className="space-y-3">{[0, 1].map((i) => <Sk key={i} className="h-40" />)}</div>
            : accounts.isError ? <ErrorState error={accounts.error} onRetry={() => accounts.refetch()} />
            : PROVIDERS.map((p) => <ProviderGroup key={p.id} provider={p.id} label={p.label} presets={presets} integration={integrations.data?.find((i) => i.provider === p.id)}
                accounts={(accounts.data ?? []).filter((a) => a.provider === p.id)} />)}
        </section>

        <section className="min-w-0">
          <div className="flex items-center justify-between mb-3 gap-2"><h2 className="text-[13px] font-semibold">Publish queue</h2>
            <div className="flex gap-1 overflow-x-auto">{["all", ...statuses].map((s) => <button key={s} onClick={() => setFilter(s)} className={cn("h-7 px-2.5 rounded-md text-[11.5px] capitalize whitespace-nowrap transition", filter === s ? "bg-white/[0.08]" : "text-zinc-500 hover:text-zinc-300")} data-testid={`filter-status-${s}`}>{s}</button>)}</div>
          </div>
          {sched.isLoading ? <Sk className="h-64" /> : sched.isError ? <ErrorState error={sched.error} onRetry={() => sched.refetch()} />
            : !entries.length ? <EmptyState icon={<CalendarClock className="w-4 h-4" />} title="Queue is empty" desc="Entries appear only after an account has auto-publish on, setup blockers cleared, and a clip is ready." />
            : <div className="panel">{entries.map((e) => (
              <div key={e.id} className="px-3.5 py-3 border-b border-white/[0.05] last:border-0" data-testid={`row-publish-${e.id}`}>
                <div className="flex items-center gap-3">
                  <div className="w-[88px] shrink-0"><div className="mono text-[12px] tabular-nums">{fmtIn(e.scheduledAt, e.timezone)}</div><div className="mono text-[9.5px] text-zinc-600 truncate">{e.timezone}</div></div>
                  <PlatformIcon p={e.platform} className="w-3.5 h-3.5 text-zinc-300 shrink-0" />
                  <div className="flex-1 min-w-0"><div className="text-[12.5px] truncate">{e.title}</div><div className="mono text-[10.5px] text-zinc-500 truncate">{e.handle} · clip #{e.clipId} · {e.language.toUpperCase()}</div></div>
                  <Pill tone={e.status === "needs_review" ? "amber" : statusTone(e.status)}>{e.status === "needs_review" ? "Needs review" : e.status}</Pill>
                </div>
                {e.status === "needs_review" && /tiktok/i.test(e.platform) && <div className="mt-2 flex justify-end"><button className={btn.primary} onClick={() => setReviewId(e.id)} data-testid={`button-review-${e.id}`}>Review & approve</button></div>}
                {e.remoteId && <div className="mono text-[10.5px] text-emerald-400/80 mt-1 ml-[100px] truncate" data-testid={`text-remote-${e.id}`}>remote id {e.remoteId}</div>}
                {e.error && <div className="text-[11.5px] text-red-300 mt-1.5 ml-0 sm:ml-[100px] bg-red-500/5 border border-red-500/15 rounded px-2 py-1 break-words" data-testid={`text-publish-error-${e.id}`}>{e.error}</div>}
                <FailureDetails status={e.status} kind={e.failureKind} count={e.attempts} retryAt={e.retryAt} />
              </div>))}</div>}
          <div className="mt-3 flex gap-2 text-[11.5px] text-zinc-500 p-3 rounded-lg border border-dashed border-white/[0.08]"><Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />Statuses come from the publisher. A post counts as published only when the platform returns a remote ID.</div>
        </section>
      </div>

      <TikTokReviewDialog entryId={reviewId} onClose={() => setReviewId(null)} />
      <ManualDrafts />
    </div>
  );
}
