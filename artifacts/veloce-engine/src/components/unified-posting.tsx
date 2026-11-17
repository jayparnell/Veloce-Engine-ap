import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetUnifiedPosting, getGetUnifiedPostingQueryKey, useSaveUnifiedPosting,
  useDiscoverUnifiedAccounts, useConnectUnifiedAccount,
  getGetAutopilotAccountsQueryKey, getGetAutopilotScheduleQueryKey,
} from "@workspace/api-client-react";
import { btn, field, Pill, errMsg } from "@/components/kit";

export function UnifiedPostingSettings() {
  const qc = useQueryClient();
  const status = useGetUnifiedPosting({ query: { refetchInterval: 30000 } });
  const [provider, setProvider] = useState<"ayrshare" | "late">("ayrshare");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (status.data?.provider === "ayrshare" || status.data?.provider === "late") setProvider(status.data.provider);
  }, [status.data?.provider]);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: getGetUnifiedPostingQueryKey() });
    qc.invalidateQueries({ queryKey: getGetAutopilotAccountsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetAutopilotScheduleQueryKey() });
  };
  const save = useSaveUnifiedPosting({ mutation: { onSuccess: () => { refresh(); setNotice("Provider saved. Discover accounts next; automatic posting stays off."); }, onError: e => setNotice(errMsg(e)) } });
  const discover = useDiscoverUnifiedAccounts({ mutation: { onSuccess: data => { refresh(); setNotice(data.accounts.length ? "Select a connected account below." : "No eligible connected accounts found. Check your provider profile, permissions and plan. ZIP exports remain available."); }, onError: e => setNotice(errMsg(e)) } });
  const connect = useConnectUnifiedAccount({ mutation: { onSuccess: data => { refresh(); setNotice(data.message); }, onError: e => setNotice(errMsg(e)) } });
  const busy = save.isPending || discover.isPending || connect.isPending;
  return <section className="panel p-4 mb-5 space-y-3" data-testid="unified-posting">
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="text-[13px] font-semibold flex-1">Unified Posting API (Ayrshare / Late)</h2>
      <Pill tone={status.data?.ready ? "emerald" : "amber"}>{status.data?.ready ? "Configured" : "Export fallback"}</Pill>
    </div>
    {status.isLoading ? <p className="text-xs text-zinc-400">Checking posting configuration…</p>
      : status.isError ? <div className="text-xs text-red-300" role="alert">{errMsg(status.error)} <button className="underline" onClick={() => status.refetch()}>Retry</button></div>
      : <p className="text-xs text-zinc-400">{status.data?.message}</p>}
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-xs space-y-1"><span className="block text-zinc-400">Service that issued your key</span>
        <select className={field} value={provider} onChange={e => setProvider(e.target.value as typeof provider)} data-testid="unified-provider">
          <option value="ayrshare">Ayrshare</option><option value="late">Late (now Zernio)</option>
        </select>
      </label>
      <button className={btn.ghost} disabled={busy || status.isLoading || status.isError} onClick={() => save.mutate({ data: { provider } })} data-testid="unified-save">{save.isPending ? "Saving…" : "Save provider"}</button>
      <button className={btn.primary} disabled={busy || !status.data?.ready || provider !== status.data.provider} onClick={() => discover.mutate()} data-testid="unified-discover">{discover.isPending ? "Discovering…" : "Discover connected accounts"}</button>
      <Link href="/vault" className={btn.ghost}>Open ZIP exports</Link>
    </div>
    {status.data && !status.data.ownerConfigured && <p className="text-[11.5px] text-zinc-400 break-all">
      Owner binding for <code>SOCIAL_POST_OWNER_ID</code>: <code className="text-zinc-200">{status.data.ownerBinding}</code>.
      {" "}Set the key securely as <code>SOCIAL_POST_API_KEY</code>, never in this page. Owner binding prevents other signed-in users from accessing your provider profiles.
    </p>}
    <p className="text-[11.5px] text-zinc-500">One destination uses one posting route. Connecting never enables automation or backfills old clips. TikTok still needs direct authorization to verify creator restrictions, then per-video privacy, music and disclosure review. Without verified permissions, export manually.</p>
    {status.data?.accounts.map(account => <div key={account.id} className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-2 text-xs" data-testid="unified-discovered-account">
      <span className="text-zinc-400 capitalize">{account.provider}</span><span className="flex-1 break-all">{account.handle}</span>
      <button className={btn.ghost} disabled={busy || provider !== status.data.provider} onClick={() => connect.mutate({ data: { id: account.id } })}>Connect with auto off</button>
    </div>)}
    {notice && <p className="text-xs text-zinc-300" role="status" data-testid="unified-notice">{notice}</p>}
  </section>;
}
