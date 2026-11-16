import { createContext, useContext, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@workspace/replit-auth-web";
import { useGetPlaybook, getGetPlaybookQueryKey, useUpdateLesson, useHealthCheck, getHealthCheckQueryKey } from "@workspace/api-client-react";
import { Clapperboard, Film, Coins, Send, BookOpen, Settings2, LogIn, LogOut, Menu, X, Check, Circle, LifeBuoy } from "lucide-react";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { Pill, Sk, ErrorState, btn } from "@/components/kit";

const NAV = [
  { href: "/", label: "Command Center", icon: Clapperboard, k: "01" },
  { href: "/vault", label: "Clip Vault", icon: Film, k: "02" },
  { href: "/monetization", label: "Monetization", icon: Coins, k: "03" },
  { href: "/distribution", label: "Schedule & Accounts", icon: Send, k: "04" },
  { href: "/playbook", label: "Playbook", icon: BookOpen, k: "05" },
  { href: "/settings", label: "Settings", icon: Settings2, k: "06" },
];

const GuideCtx = createContext<{ open: () => void }>({ open: () => {} });
export const useGuide = () => useContext(GuideCtx);

export function GuideSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const q = useGetPlaybook({ query: { queryKey: getGetPlaybookQueryKey(), enabled: open } });
  const upd = useUpdateLesson({ mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getGetPlaybookQueryKey() }) } });
  const [active, setActive] = useState<number | null>(null);
  const lessons = q.data ?? [];
  const done = lessons.filter((l) => l.completed).length;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="bg-[#0E0E11] border-l border-white/[0.08] w-full sm:max-w-md p-0 flex flex-col">
        <div className="px-5 pt-5 pb-4 border-b border-white/[0.06]">
          <div className="label-xs mono">Operator guide</div>
          <SheetTitle className="text-[16px] font-semibold mt-1">Playbook</SheetTitle>
          <SheetDescription className="text-[12px] text-muted-foreground">Field notes for running authorized commentary production. Progress syncs to your workspace.</SheetDescription>
          {lessons.length > 0 && (
            <div className="mt-3">
              <div className="flex justify-between text-[11px] mono text-muted-foreground mb-1"><span>{done}/{lessons.length} complete</span><span>{Math.round((done / lessons.length) * 100)}%</span></div>
              <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden"><div className="h-full bg-emerald-500 transition-all" style={{ width: `${(done / lessons.length) * 100}%` }} /></div>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {q.isLoading && [0, 1, 2, 3].map((i) => <Sk key={i} className="h-14" />)}
          {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
          {lessons.map((l) => (
            <div key={l.id} className={cn("rounded-lg border transition", active === l.id ? "border-white/[0.12] bg-white/[0.03]" : "border-transparent hover:bg-white/[0.02]")}>
              <div className="flex items-center gap-3 px-3 py-2.5">
                <button
                  data-testid={`guide-toggle-${l.id}`}
                  disabled={upd.isPending}
                  onClick={() => upd.mutate({ id: l.id, data: { completed: !l.completed } })}
                  className={cn("w-4 h-4 rounded-full border flex items-center justify-center shrink-0 transition", l.completed ? "bg-emerald-500 border-emerald-500 text-[#06130D]" : "border-white/20 hover:border-emerald-500/60")}
                  aria-label="Toggle complete"
                >
                  {l.completed && <Check className="w-2.5 h-2.5" strokeWidth={3} />}
                </button>
                <button className="flex-1 text-left min-w-0" onClick={() => setActive(active === l.id ? null : l.id)}>
                  <div className={cn("text-[13px] truncate", l.completed && "text-muted-foreground line-through decoration-white/20")}>{l.title}</div>
                  <div className="text-[10.5px] mono text-muted-foreground uppercase tracking-wide">{l.category} · {l.minutes} min</div>
                </button>
              </div>
              {active === l.id && <div className="px-10 pb-3 text-[12.5px] leading-relaxed text-zinc-300 whitespace-pre-line">{l.content}</div>}
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [loc] = useLocation();
  const [mobile, setMobile] = useState(false);
  const [guide, setGuide] = useState(false);
  const { user, isAuthenticated, isLoading, login, logout } = useAuth();
  const health = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 30000 } });
  const apiUp = health.data?.status === "ok" || (!!health.data && !health.isError);

  const nav = (
    <nav className="flex flex-col gap-0.5">
      {NAV.map((n) => {
        const on = n.href === "/" ? loc === "/" : loc.startsWith(n.href);
        return (
          <Link key={n.href} href={n.href} onClick={() => setMobile(false)} data-testid={`link-nav-${n.label.toLowerCase().replace(/\s/g, "-")}`}
            className={cn("group flex items-center gap-2.5 h-8 px-2.5 rounded-md text-[13px] transition relative", on ? "bg-white/[0.06] text-foreground" : "text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.03]")}>
            {on && <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-emerald-500" />}
            <n.icon className={cn("w-[15px] h-[15px]", on ? "text-emerald-400" : "")} />
            <span className="flex-1">{n.label}</span>
            <span className="mono text-[10px] text-zinc-600 group-hover:text-zinc-500">{n.k}</span>
          </Link>
        );
      })}
    </nav>
  );

  const name = user ? [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email || "Operator" : "";
  const initials = name ? name.split(/\s|@/).filter(Boolean).slice(0, 2).map((s: string) => s[0]?.toUpperCase()).join("") : "";

  const authBlock = (
    <div className="border-t border-white/[0.06] pt-3">
      {isLoading ? <Sk className="h-9" /> : isAuthenticated ? (
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md bg-emerald-500/15 border border-emerald-500/25 text-emerald-300 text-[11px] font-semibold flex items-center justify-center">{initials}</div>
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] truncate" data-testid="text-username">{name}</div>
            <div className="text-[10.5px] mono text-muted-foreground">Signed in</div>
          </div>
          <button onClick={logout} className={btn.icon} aria-label="Log out" data-testid="button-logout"><LogOut className="w-3.5 h-3.5" /></button>
        </div>
      ) : (
        <div>
          <div className="text-[11.5px] text-muted-foreground mb-2 leading-snug">Log in to open your private studio, process sources and manage your accounts.</div>
          <button onClick={login} className={cn(btn.primary, "w-full")} data-testid="button-login"><LogIn className="w-3.5 h-3.5" /> Log in</button>
        </div>
      )}
    </div>
  );

  const side = (
    <div className="flex flex-col h-full p-3 gap-4">
      <div className="flex items-center gap-2 px-1.5 pt-1">
        <div className="w-6 h-6 rounded-[5px] bg-emerald-500 flex items-center justify-center">
          <svg viewBox="0 0 16 16" className="w-3.5 h-3.5"><path d="M2 3h3.2L8 10.5 10.8 3H14L9.6 13H6.4z" fill="#06130D" /></svg>
        </div>
        <span className="text-[14px] font-semibold tracking-tight">Veloce</span>
        <span className="mono text-[10px] text-zinc-500 mt-0.5">ENGINE</span>
      </div>
      {nav}
      <div className="mt-auto space-y-3">
        <button onClick={() => setGuide(true)} className="w-full flex items-center gap-2.5 h-8 px-2.5 rounded-md text-[12.5px] text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.03] border border-dashed border-white/[0.08]" data-testid="button-open-guide">
          <LifeBuoy className="w-[15px] h-[15px]" /> Operator guide
          <kbd className="ml-auto mono text-[10px] text-zinc-600">?</kbd>
        </button>
        <div className="flex items-center gap-2 px-2.5 text-[10.5px] mono text-muted-foreground">
          {health.isLoading ? <Circle className="w-2 h-2" /> : <span className={cn("w-1.5 h-1.5 rounded-full", apiUp ? "bg-emerald-500" : "bg-red-500")} />}
          API {health.isLoading ? "checking" : apiUp ? "online" : "unreachable"}
        </div>
        {authBlock}
      </div>
    </div>
  );

  return (
    <GuideCtx.Provider value={{ open: () => setGuide(true) }}>
      <div className="min-h-[100dvh] flex">
        <aside className="hidden md:block w-[232px] shrink-0 border-r border-white/[0.06] bg-[#0B0B0D] sticky top-0 h-[100dvh]">{side}</aside>
        {mobile && (
          <div className="md:hidden fixed inset-0 z-50 flex">
            <div className="w-[260px] bg-[#0B0B0D] border-r border-white/[0.08] h-full">{side}</div>
            <button className="flex-1 bg-black/60" onClick={() => setMobile(false)} aria-label="Close menu" />
          </div>
        )}
        <div className="flex-1 min-w-0 flex flex-col">
          <header className="md:hidden h-12 border-b border-white/[0.06] flex items-center px-3 gap-2 sticky top-0 bg-[#09090B]/90 backdrop-blur z-40">
            <button className={btn.icon} onClick={() => setMobile(!mobile)} data-testid="button-menu">{mobile ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}</button>
            <span className="text-[14px] font-semibold">Veloce</span>
            <div className="ml-auto flex items-center gap-2">
              {!isAuthenticated && !isLoading && <Pill tone="neutral">Signed out</Pill>}
              <button className={btn.icon} onClick={() => setGuide(true)} aria-label="Guide"><LifeBuoy className="w-4 h-4" /></button>
            </div>
          </header>
          <main className="flex-1 px-4 md:px-8 py-6 md:py-8 max-w-[1400px] w-full mx-auto">{children}</main>
        </div>
      </div>
      <GuideSheet open={guide} onOpenChange={setGuide} />
    </GuideCtx.Provider>
  );
}
