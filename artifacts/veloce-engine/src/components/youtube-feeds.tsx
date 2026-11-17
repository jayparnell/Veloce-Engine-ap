import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListYoutubeFeeds, getListYoutubeFeedsQueryKey, useAddYoutubeFeed, useUpdateYoutubeFeed, useRemoveYoutubeFeed,
  getGetAutopilotSwarmQueryKey, getGetRenderBudgetQueryKey, type YoutubeFeed,
} from "@workspace/api-client-react";
import { Rss, Plus, Pause, Play, Trash2, Info } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Pill, Sk, ErrorState, errMsg, btn, field } from "./kit";

const TAB = "(?:/(?:videos|shorts|streams|featured))?/?";
const URL_PATTERNS = [
  new RegExp(`^/channel/UC[A-Za-z0-9_-]{22}${TAB}$`),
  new RegExp(`^/@[\\p{L}\\p{M}\\p{N}._-]{1,100}${TAB}$`, "u"),
  new RegExp(`^/c/[\\p{L}\\p{M}\\p{N}._-]{1,100}${TAB}$`, "u"),
  new RegExp(`^/user/[\\p{L}\\p{M}\\p{N}._-]{1,100}${TAB}$`, "u"),
];
const PL_RE = /^(?:UU[A-Za-z0-9_-]{22}|PL[A-Za-z0-9_-]{10,78})$/;

/** Client-side precheck only. The backend remains authoritative. */
export function validateFeedSource(raw: string): string | null {
  const s = raw.trim();
  if (!s) return "Enter a channel ID, playlist ID, @handle or YouTube URL.";
  if (s.length > 512) return "Too long (512 characters max).";
  if (/^UC[A-Za-z0-9_-]{22}$/.test(s)) return null;
  if (PL_RE.test(s)) return null;
  if (/^@[\p{L}\p{M}\p{N}._-]{1,100}$/u.test(s)) return null;
  if (/^(UC|PL|UU)/.test(s) && !/[/.:]/.test(s)) return "Unsupported ID: channel IDs are UC plus 22 characters (24 total); playlist IDs are PL with 12 to 80 characters total, or UU plus 22.";
  let u: URL;
  try { u = new URL(s); } catch { return "Unsupported input. Use a UC channel ID, PL/UU playlist ID, @handle, or an HTTPS youtube.com URL."; }
  if (u.protocol !== "https:") return "Unsupported URL: only HTTPS is accepted.";
  if (u.username || u.password || u.port || u.hash) return "Remove credentials, ports and fragments from the YouTube URL.";
  if (!["youtube.com", "www.youtube.com", "m.youtube.com"].includes(u.hostname.toLowerCase())) return "Unsupported host: only youtube.com, www.youtube.com or m.youtube.com. Short links and video URLs are not feeds.";
  if (u.pathname === "/playlist" || u.pathname === "/playlist/") {
    const l = u.searchParams.get("list") ?? "";
    if ([...u.searchParams.keys()].some((k) => k !== "list") || u.searchParams.getAll("list").length !== 1) return "Use a playlist URL with only one list= parameter.";
    return PL_RE.test(l) ? null : "Unsupported playlist: list= must be a PL (12 to 80 chars) or UU (24 chars) ID. Mixes and other list types are not supported.";
  }
  if (u.search) return "Remove query parameters from the channel URL.";
  try { if (URL_PATTERNS.some((r) => r.test(decodeURIComponent(u.pathname)))) return null; }
  catch { return "Invalid channel URL encoding."; }
  return "Unsupported YouTube URL. Supported: /channel/UC..., /@handle, /c/name, /user/name (optional videos, shorts, streams or featured tab) and /playlist?list=.";
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

function feedState(f: YoutubeFeed): { label: string; tone: "emerald" | "amber" | "red" | "neutral" | "sky" } {
  if (f.paused) return { label: "Paused", tone: "neutral" };
  if (f.error) return { label: "Error", tone: "red" };
  if (f.budgetDeferredCount > 0) return { label: "Budget-deferred", tone: "amber" };
  if (!f.baselineAt) return { label: "Baselining", tone: "sky" };
  return { label: "Active", tone: "emerald" };
}

function FeedRow({ f }: { f: YoutubeFeed }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [confirm, setConfirm] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: getListYoutubeFeedsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetAutopilotSwarmQueryKey() });
    qc.invalidateQueries({ queryKey: getGetRenderBudgetQueryKey() });
  };
  const upd = useUpdateYoutubeFeed({ mutation: { onSuccess: (r) => { refresh(); toast({ title: f.paused ? "Feed resumed" : "Feed paused", description: r.message }); }, onError: (e) => toast({ title: "Could not update feed", description: errMsg(e), variant: "destructive" }) } });
  const rem = useRemoveYoutubeFeed({ mutation: { onSuccess: () => { refresh(); setConfirm(false); toast({ title: "Feed removed", description: "No new uploads will be admitted. Queued jobs and finished clips are unchanged." }); }, onError: (e) => toast({ title: "Could not remove feed", description: errMsg(e), variant: "destructive" }) } });
  const st = feedState(f);
  return (
    <div className="px-4 py-3 border-b border-white/[0.05] last:border-0" data-testid={`row-feed-${f.id}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[12.5px] font-medium truncate max-w-[60%]" data-testid={`text-feed-title-${f.id}`}>{f.title || f.providerId}</span>
        <Pill tone="neutral">{f.kind}</Pill>
        <Pill tone={st.tone} dot={st.label === "Active"}>{st.label}</Pill>
        {f.pendingCount > 0 && <Pill tone="sky">{f.pendingCount} pending</Pill>}
        <div className="ml-auto flex gap-1">
          <button className={btn.icon} disabled={upd.isPending} onClick={() => upd.mutate({ id: f.id, data: { paused: !f.paused } })} aria-label={f.paused ? "Resume feed" : "Pause feed"} data-testid={`button-toggle-feed-${f.id}`}>{f.paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}</button>
          <button className={btn.icon} onClick={() => setConfirm(true)} aria-label="Remove feed" data-testid={`button-remove-feed-${f.id}`}><Trash2 className="w-3.5 h-3.5" /></button>
        </div>
      </div>
      <div className="mono text-[10.5px] text-zinc-500 mt-1 break-all">{f.providerId}</div>
      <div className="mono text-[10.5px] text-zinc-400 mt-1 flex flex-wrap gap-x-3" data-testid={`text-feed-times-${f.id}`}>
        <span>checked {fmt(f.lastCheckedAt)}</span><span>ok {fmt(f.lastSuccessAt)}</span>{!f.paused && <span>next {fmt(f.nextPollAt)}</span>}
      </div>
      {!f.baselineAt && !f.paused && <p className="text-[11px] text-sky-300/80 mt-1">The first successful poll records a baseline. Existing uploads are not backfilled.</p>}
      {f.baselineAt && <p className="text-[11px] text-zinc-500 mt-1">Baseline set {fmt(f.baselineAt)}. Existing uploads were not backfilled.</p>}
      {f.budgetDeferredCount > 0 && <p className="text-[11px] text-amber-300 mt-1" data-testid={`text-feed-deferred-${f.id}`}>{f.budgetDeferredCount} upload{f.budgetDeferredCount === 1 ? "" : "s"} deferred by the Daily Render Cap{f.deferredUntil ? ` until ${fmt(f.deferredUntil)}` : ""}. Allowance resets at midnight EST (fixed UTC-05:00).</p>}
      {f.error && <div className="text-[11px] text-red-300 mt-1.5 bg-red-500/5 border border-red-500/15 rounded px-2 py-1 break-words" data-testid={`text-feed-error-${f.id}`}>{f.error}</div>}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent className="bg-[#121215] border-white/[0.08] max-w-[calc(100vw-24px)] sm:max-w-md">
          <DialogTitle className="text-[15px]">Remove {f.title || f.providerId}?</DialogTitle>
          <DialogDescription className="text-[12.5px]">Stops future admissions from this feed. Jobs already queued and clips already finished are not cancelled or deleted. Pausing does the same without forgetting the feed.</DialogDescription>
          <div className="flex justify-end gap-2"><button className={btn.ghost} onClick={() => setConfirm(false)}>Cancel</button><button className={btn.danger} disabled={rem.isPending} onClick={() => rem.mutate({ id: f.id })} data-testid={`button-confirm-remove-feed-${f.id}`}>{rem.isPending ? "Removing..." : "Remove"}</button></div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function YoutubeFeeds() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const feeds = useListYoutubeFeeds({ query: { refetchInterval: 10000, refetchOnWindowFocus: true } });
  const [source, setSource] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [touched, setTouched] = useState(false);
  const invalid = validateFeedSource(source);
  const add = useAddYoutubeFeed({ mutation: {
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: getListYoutubeFeedsQueryKey() }); setSource(""); setAuthorized(false); setTouched(false); toast({ title: "Feed added", description: r.message }); },
    onError: (e) => toast({ title: "Feed not added", description: errMsg(e), variant: "destructive" }),
  } });
  const submit = () => { setTouched(true); if (!invalid && authorized) add.mutate({ data: { source: source.trim(), authorizedUse: true } }); };
  const data = feeds.data;
  return (
    <section className="panel overflow-hidden my-4" data-testid="panel-youtube-feeds">
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/[0.06] bg-white/[0.012] flex-wrap">
        <Rss className="w-4 h-4 text-emerald-400" />
        <span className="text-[13px] font-semibold flex-1">Auto-Watch Channels (RSS)</span>
        {data && <Pill tone={data.serviceRunning ? "emerald" : "amber"} dot={data.serviceRunning}>Feed watcher {data.serviceRunning ? "running" : "stopped"}</Pill>}
      </div>
      <div className="px-4 py-3 border-b border-white/[0.06] space-y-2">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <input value={source} onChange={(e) => setSource(e.target.value)} onBlur={() => source && setTouched(true)} placeholder="UC... / PL... / @handle / https://www.youtube.com/@handle" className={cn(field, "mono text-[16px] sm:text-[12.5px]", touched && invalid && "border-amber-500/50")} autoCapitalize="off" autoCorrect="off" maxLength={512} data-testid="input-feed-source" />
          <button type="submit" className={btn.primary} disabled={add.isPending || !!invalid || !authorized} data-testid="button-add-feed"><Plus className="w-3.5 h-3.5" />{add.isPending ? "Adding..." : "Watch"}</button>
        </form>
        {touched && invalid && <div className="mono text-[10.5px] text-amber-400" data-testid="text-feed-validation">{invalid}</div>}
        <label className="flex items-start gap-2.5 text-[11.5px] cursor-pointer">
          <input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} className="accent-emerald-500 mt-0.5 w-4 h-4" data-testid="checkbox-feed-authorized" />
          <span className="text-zinc-400">I own this channel or playlist, or hold permission to produce commentary from its uploads. Subscribing grants no permission to reuse or republish another creator's work.</span>
        </label>
      </div>
      {feeds.isLoading ? <div className="p-4"><Sk className="h-16" /></div>
        : feeds.isError ? <div className="p-3"><ErrorState error={feeds.error} onRetry={() => feeds.refetch()} /></div>
        : !data?.feeds.length ? <div className="px-4 py-4 text-[12px] text-zinc-500" data-testid="text-feeds-empty">No watched feeds. New uploads are only admitted after a feed is added and baselined.</div>
        : data.feeds.map((f) => <FeedRow key={f.id} f={f} />)}
      <div className="px-4 py-2.5 border-t border-white/[0.06] flex gap-2 text-[11px] text-zinc-500">
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>{data?.message && <span className="text-zinc-400 block" data-testid="text-feeds-message">{data.message}</span>}Polled every 15 minutes only while the dedicated feed service runs. Polling uses no AI. RSS exposes a bounded recent window, so uploads during downtime may be missed. Pausing or removal stops future admissions only; queued jobs and finished clips are unaffected. Admitted uploads count against the Daily Render Cap, which resets at midnight EST (fixed UTC-05:00).</span>
      </div>
    </section>
  );
}
