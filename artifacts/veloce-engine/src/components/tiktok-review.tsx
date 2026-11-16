import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetPublishingReview, getGetPublishingReviewQueryKey, useApprovePublishingReview, getGetAutopilotScheduleQueryKey } from "@workspace/api-client-react";
import { AlertTriangle } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Sk, ErrorState, btn, errMsg, fmtDur } from "./kit";

const PRIVACY_LABEL: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends (mutual followers)",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};

export function TikTokReviewDialog({ entryId, onClose }: { entryId: number | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const id = entryId ?? 0;
  const review = useGetPublishingReview(id, { query: { queryKey: getGetPublishingReviewQueryKey(id), enabled: entryId != null, staleTime: 0 } });
  const [privacy, setPrivacy] = useState("");
  const [allowComment, setAllowComment] = useState(false);
  const [allowDuet, setAllowDuet] = useState(false);
  const [allowStitch, setAllowStitch] = useState(false);
  const [consent, setConsent] = useState(false);
  const [brandContent, setBrandContent] = useState(false);
  const [brandOrganic, setBrandOrganic] = useState(false);

  useEffect(() => { setPrivacy(""); setAllowComment(false); setAllowDuet(false); setAllowStitch(false); setConsent(false); setBrandContent(false); setBrandOrganic(false); }, [entryId]);

  const approve = useApprovePublishingReview({ mutation: {
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: getGetAutopilotScheduleQueryKey() }); toast({ title: "Review submitted", description: r.message }); onClose(); },
    onError: (e) => toast({ title: "Could not approve", description: errMsg(e), variant: "destructive" }),
  } });

  const d = review.data;
  const canApprove = !!d && d.canPost && !!privacy && consent && (!brandContent || privacy === "PUBLIC_TO_EVERYONE") && !approve.isPending;
  const toggles = d ? [
    { key: "comment", label: "Allow comments", on: allowComment, set: setAllowComment, forbidden: d.commentDisabled },
    { key: "duet", label: "Allow Duet", on: allowDuet, set: setAllowDuet, forbidden: d.duetDisabled },
    { key: "stitch", label: "Allow Stitch", on: allowStitch, set: setAllowStitch, forbidden: d.stitchDisabled },
  ] : [];

  return (
    <Dialog open={entryId != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="bg-[#121215] border-white/[0.08] max-w-[calc(100vw-16px)] sm:max-w-2xl max-h-[92dvh] overflow-y-auto">
        <DialogTitle className="text-[15px]">Review before posting to TikTok</DialogTitle>
        <DialogDescription className="text-[12px]">Each TikTok post needs your review. Turning on auto-publish only assigns clips to this account; it does not approve them.</DialogDescription>
        {review.isLoading ? <div className="grid sm:grid-cols-[200px_1fr] gap-4"><Sk className="aspect-[9/16]" /><Sk className="h-64" /></div>
          : review.isError ? <ErrorState title="Review details unavailable" error={review.error} onRetry={() => review.refetch()} />
          : d && (
          <form className="grid sm:grid-cols-[200px_1fr] gap-4" onSubmit={(e) => { e.preventDefault(); if (canApprove) approve.mutate({ id, data: { privacyLevel: privacy, disableComment: d.commentDisabled || !allowComment, disableDuet: d.duetDisabled || !allowDuet, disableStitch: d.stitchDisabled || !allowStitch, consent, brandContent, brandOrganic } }); }}>
            <div>
              <video src={d.videoUrl} controls playsInline preload="metadata" className="w-full aspect-[9/16] rounded-lg bg-[#050506] border border-white/[0.08] object-cover" aria-label={`Video preview: ${d.title}`} data-testid="video-review" />
              <div className="mono text-[10.5px] text-zinc-500 mt-1.5">Max allowed duration {fmtDur(d.maxDuration)}</div>
            </div>
            <div className="space-y-3 min-w-0">
              <div><div className="label-xs">Posting as</div><div className="text-[13px] mono mt-0.5" data-testid="text-review-creator">{d.creatorName}</div></div>
              <div><div className="label-xs">Title</div><div className="text-[13px] mt-0.5 break-words" data-testid="text-review-title">{d.title}</div></div>
              <div><div className="label-xs">Caption</div><p className="text-[12.5px] text-zinc-300 mt-0.5 whitespace-pre-wrap break-words max-h-28 overflow-y-auto" data-testid="text-review-caption">{d.caption || "(no caption)"}</p></div>

              <fieldset>
                <legend className="label-xs mb-1.5">Who can view this video <span className="text-amber-400">required</span></legend>
                <div className="grid grid-cols-2 gap-1.5" role="radiogroup">
                  {d.privacyOptions.map((p) => (
                    <label key={p} className={cn("flex items-center gap-2 min-h-10 px-2.5 rounded-md border text-[12px] cursor-pointer transition", privacy === p ? "border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-300" : "border-white/[0.08] text-zinc-300")}>
                      <input type="radio" name="privacy" value={p} checked={privacy === p} onChange={() => setPrivacy(p)} className="accent-emerald-500" data-testid={`radio-privacy-${p}`} />
                      {PRIVACY_LABEL[p] ?? p}
                    </label>))}
                </div>
                {!privacy && <div className="text-[11px] text-zinc-500 mt-1">No default. Choose a visibility for this post.</div>}
              </fieldset>

              <fieldset className="space-y-1.5">
                <legend className="label-xs mb-1.5">Interactions</legend>
                {toggles.map((t) => (
                  <label key={t.key} className={cn("flex items-center gap-2.5 text-[12.5px]", t.forbidden ? "opacity-50" : "cursor-pointer")}>
                    <input type="checkbox" checked={!t.forbidden && t.on} disabled={t.forbidden} onChange={(e) => t.set(e.target.checked)} className="accent-emerald-500 w-4 h-4" data-testid={`checkbox-allow-${t.key}`} />
                    {t.label}{t.forbidden && <span className="text-[11px] text-zinc-500">Disabled by this creator's TikTok settings</span>}
                  </label>))}
              </fieldset>

              <fieldset className="space-y-2 text-[12px]">
                <legend className="label-xs mb-1.5">Commercial content disclosures</legend>
                <label className="flex items-center gap-2.5"><input type="checkbox" checked={brandOrganic} onChange={(e) => setBrandOrganic(e.target.checked)} className="accent-emerald-500" />Promotes my own brand or business</label>
                <label className="flex items-center gap-2.5"><input type="checkbox" checked={brandContent} onChange={(e) => setBrandContent(e.target.checked)} className="accent-emerald-500" />Paid or incentivized partner brand content</label>
                {brandContent && privacy !== "PUBLIC_TO_EVERYONE" && <p className="text-amber-300">Partner content requires an explicit public privacy choice. Nothing will be sent with a private selection.</p>}
              </fieldset>
              <div className="rounded-md border border-amber-500/15 bg-amber-500/[0.04] p-2.5 text-[11.5px] text-zinc-300 flex gap-2"><AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />Veloce Engine does not clear copyright or music rights. You are responsible for the audio and footage in this video.</div>
              <label className="flex items-start gap-2.5 text-[12px] text-zinc-300 cursor-pointer">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="accent-emerald-500 w-4 h-4 mt-0.5 shrink-0" data-testid="checkbox-review-consent" />
                <span>For this specific video, I confirm the commercial disclosures above are accurate, agree to TikTok's <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer" className="text-emerald-400 underline">Music Usage Confirmation</a> and confirm it complies with TikTok's <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noreferrer" className="text-emerald-400 underline">Branded Content Policy</a>.</span>
              </label>
              {!d.canPost && <div className="text-[12px] text-red-300 bg-red-500/5 border border-red-500/15 rounded-md px-2.5 py-1.5" role="alert">TikTok is not accepting posts from this account right now. Try again later.</div>}
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" className={btn.ghost} onClick={onClose}>Not now</button>
                <button type="submit" className={btn.primary} disabled={!canApprove} data-testid="button-approve-review">{approve.isPending ? "Submitting..." : "Approve and post"}</button>
              </div>
              <p className="text-[10.5px] text-zinc-500">After you approve, the post may take a few minutes to appear on TikTok.</p>
            </div>
          </form>)}
      </DialogContent>
    </Dialog>
  );
}
