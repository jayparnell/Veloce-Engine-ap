import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCreateExport, useCloneAndDub, getGetAutopilotSwarmQueryKey, getListClipsQueryKey, type ExportResult } from "@workspace/api-client-react";
import { Download, Languages } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Pill, btn, errMsg } from "./kit";

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
