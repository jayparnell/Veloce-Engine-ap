import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@workspace/replit-auth-web";
import { useGetSocialIntegrations, getGetSocialIntegrationsQueryKey, useSaveSocialIntegration, useDisconnectSocialIntegration, getListPlatformAccountsQueryKey, getGetAutopilotAccountsQueryKey, type SocialIntegration } from "@workspace/api-client-react";
import { ExternalLink, LockKeyhole, Save, Unplug } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Pill, Sk, ErrorState, btn, field, errMsg } from "./kit";

const PH: Record<string, string> = { youtube: "your-app.apps.googleusercontent.com", tiktok: "Your TikTok application client key", instagram: "Your Meta (Instagram) app ID", x: "Your X developer app client ID" };

function IntegrationCard({ integration }: { integration: SocialIntegration }) {
  const { isAuthenticated } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [clientId, setClientId] = useState(integration.clientId);
  const [appApproved, setAppApproved] = useState(integration.appApproved);
  useEffect(() => { setClientId(integration.clientId); setAppApproved(integration.appApproved); }, [integration.clientId, integration.appApproved]);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: getGetSocialIntegrationsQueryKey() });
    qc.invalidateQueries({ queryKey: getListPlatformAccountsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetAutopilotAccountsQueryKey() });
  };
  const save = useSaveSocialIntegration({ mutation: {
    onSuccess: () => { refresh(); toast({ title: "Integration settings saved", description: "Public configuration saved. Client secrets stay server-side." }); },
    onError: (error) => toast({ title: "Could not save settings", description: errMsg(error), variant: "destructive" }),
  } });
  const disconnect = useDisconnectSocialIntegration({ mutation: {
    onSuccess: () => { refresh(); toast({ title: "Account disconnected", description: "Stored tokens removed. You can also revoke access in your platform account settings." }); },
    onError: (error) => toast({ title: "Could not disconnect", description: errMsg(error), variant: "destructive" }),
  } });
  const dirty = clientId !== integration.clientId || appApproved !== integration.appApproved;
  return (
    <form className="border-t border-white/[0.08] first:border-0 py-5 first:pt-0 last:pb-0" data-testid={`integration-${integration.provider}`}
      onSubmit={(event) => { event.preventDefault(); save.mutate({ provider: integration.provider, data: { clientId: clientId.trim(), appApproved } }); }}>
      <div className="flex items-center justify-between gap-3 mb-4">
        <h3 className="text-sm font-medium">{integration.name}</h3>
        <Pill tone={integration.connected ? "emerald" : integration.canConnect ? "amber" : "neutral"}>{integration.connected ? "Authorized" : integration.canConnect ? "Ready to connect" : "Setup required"}</Pill>
      </div>
      <label className="block text-xs text-zinc-400 mb-3">
        {integration.provider === "youtube" ? "Public OAuth client ID" : integration.provider === "tiktok" ? "Public client key" : integration.provider === "instagram" ? "Meta app ID" : "OAuth 2.0 client ID"}
        <input value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={!isAuthenticated || save.isPending}
          autoComplete="off" maxLength={500} className={`${field} mt-1.5 w-full mono text-xs`} placeholder={PH[integration.provider]}
          data-testid={`input-${integration.provider}-client-id`} />
      </label>
      <label className="block text-xs text-zinc-400 mb-3">OAuth callback URL for this domain
        <input readOnly value={integration.redirectUri} className={`${field} mt-1.5 w-full mono text-[11px]`} onFocus={(e) => e.target.select()} data-testid={`input-${integration.provider}-callback`} />
      </label>
      <div className="text-[11px] text-zinc-500 break-words mb-3">Requested scopes: <span className="mono">{integration.scopes}</span></div>
      <div className="rounded-md border border-white/[0.06] bg-black/20 p-3 text-xs mb-3 space-y-2">
        <div className="flex gap-2 items-center"><LockKeyhole className="h-3.5 w-3.5 text-zinc-400" /><span className="flex-1">Client secret <code className="text-zinc-400">{integration.secretName}</code></span><Pill tone={integration.secretConfigured ? "emerald" : "amber"}>{integration.secretConfigured ? "Configured" : "Not set"}</Pill></div>
        {integration.apiKeyName && <div className="flex gap-2 items-center"><LockKeyhole className="h-3.5 w-3.5 text-zinc-400" /><span className="flex-1">Optional API key <code className="text-zinc-400">{integration.apiKeyName}</code></span><Pill tone={integration.apiKeyConfigured ? "emerald" : "neutral"}>{integration.apiKeyConfigured ? "Configured" : "Not set"}</Pill></div>}
        <p className="text-zinc-500 leading-relaxed">Add credentials in this project’s <strong className="font-medium text-zinc-400">Tools → Secrets</strong> using these exact names. Secret values are never sent to this screen.{integration.apiKeyName && " An API key alone cannot authorize YouTube uploads; OAuth consent is required."}</p>
      </div>
      <label className="flex items-start gap-2 text-xs text-zinc-400 mb-4"><input type="checkbox" checked={appApproved} onChange={(e) => setAppApproved(e.target.checked)} disabled={!isAuthenticated} className="accent-emerald-500 mt-0.5" data-testid={`checkbox-${integration.provider}-approved`} />
        My application has the platform approval or test-user access required for these scopes.</label>
      <p className="text-xs text-zinc-400 mb-3" role="status">{integration.message}</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={!isAuthenticated || save.isPending || !dirty} className={btn.primary} data-testid={`button-save-${integration.provider}`}><Save className="h-3.5 w-3.5" />{save.isPending ? "Saving…" : "Save configuration"}</button>
        {integration.canConnect && !dirty && isAuthenticated && <a className={btn.ghost} href={`/api/social/oauth/${integration.provider}/start`} data-testid={`button-connect-${integration.provider}`}><ExternalLink className="h-3.5 w-3.5" />{integration.connected ? "Authorize additional account" : "Authorize account"}</a>}
        {integration.connected && <button type="button" className={btn.ghost} disabled={disconnect.isPending} onClick={() => { if (window.confirm(`Remove saved tokens for ALL ${integration.name} accounts? To remove a single account, use Schedule & Accounts. No videos are deleted.`)) disconnect.mutate({ provider: integration.provider }); }}><Unplug className="h-3.5 w-3.5" />Disconnect all</button>}
      </div>
      {integration.connected && <p className="text-[11px] text-zinc-500 mt-2">Disconnect individual accounts and set auto-publish in <a href={`${import.meta.env.BASE_URL.replace(/\/$/, "")}/distribution`} className="text-emerald-400">Schedule & Accounts</a>.</p>}
    </form>
  );
}

export function IntegrationSettings() {
  const integrations = useGetSocialIntegrations({ query: { queryKey: getGetSocialIntegrationsQueryKey(), refetchOnWindowFocus: true, refetchInterval: 30000 } });
  const [notice] = useState(() => new URLSearchParams(window.location.search).get("oauth"));
  return <section className="panel p-5 mt-4">
    <div className="label-xs mb-4">Social API configuration</div>
    {notice === "connected" && <p className="text-sm text-emerald-400 mb-4">Account authorized. No videos were published. Auto-publish stays off until you enable it per account.</p>}
    {notice === "failed" && <p className="text-sm text-amber-400 mb-4">Authorization was cancelled or failed. Check your client ID, callback URL, approval and granted scopes, then retry.</p>}
    <p className="text-xs text-zinc-500 leading-relaxed mb-5">AI narration uses <span className="mono text-zinc-300">gpt-audio · onyx · MP3</span> through Replit AI Integrations. No external OpenAI key is required. Social OAuth setup is separate; saving settings or authorizing an account never publishes videos.</p>
    {integrations.isLoading ? <Sk className="h-40" /> : integrations.isError ? <ErrorState error={integrations.error} onRetry={() => integrations.refetch()} /> : integrations.data?.map((integration) => <IntegrationCard key={integration.provider} integration={integration} />)}
  </section>;
}
