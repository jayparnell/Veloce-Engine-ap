import type { ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";

export const STAGES = ["Queued", "Ingest", "Transcribe", "Moment detect", "Script + score", "Package"];

export function isActiveStatus(s: string) {
  return !["complete", "completed", "ready", "failed", "error", "done"].includes(s.toLowerCase());
}

export function errMsg(e: unknown): string {
  if (!e) return "Unknown error";
  const anyE = e as { message?: string; data?: { error?: string; message?: string } };
  return anyE.data?.error || anyE.data?.message || anyE.message || "Request failed";
}

export function fmtMoney(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}
export function fmtNum(n: number) {
  return n.toLocaleString("en-US");
}
export function fmtDur(s: number) {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function PageHeader({ eyebrow, title, desc, actions }: { eyebrow: string; title: string; desc?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-6 rise">
      <div>
        <div className="label-xs mono mb-1.5">{eyebrow}</div>
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {desc && <p className="text-[13px] text-muted-foreground mt-1 max-w-2xl">{desc}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}

export function Pill({ tone = "neutral", children, dot, className }: { tone?: "emerald" | "amber" | "red" | "neutral" | "sky"; children: ReactNode; dot?: boolean; className?: string }) {
  const tones = {
    emerald: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
    amber: "text-amber-400 bg-amber-500/10 border-amber-500/20",
    red: "text-red-400 bg-red-500/10 border-red-500/20",
    sky: "text-sky-300 bg-sky-500/10 border-sky-500/20",
    neutral: "text-zinc-400 bg-white/[0.03] border-white/[0.08]",
  };
  return (
    <span className={cn("inline-flex items-center gap-1.5 h-5 px-1.5 rounded-[5px] border text-[10.5px] font-medium mono uppercase tracking-wide whitespace-nowrap", tones[tone], className)}>
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-current pulse-dot" />}
      {children}
    </span>
  );
}

export function DemoTag() {
  return <Pill tone="amber">Demo</Pill>;
}

export function statusTone(s: string): "emerald" | "amber" | "red" | "neutral" | "sky" {
  const x = s.toLowerCase();
  if (["ready", "complete", "completed", "active", "connected", "exported"].includes(x)) return "emerald";
  if (["failed", "error"].includes(x)) return "red";
  if (["paused", "draft", "planned", "scheduled"].includes(x)) return "amber";
  if (isActiveStatus(x)) return "sky";
  return "neutral";
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("panel", className)}>{children}</div>;
}

export function ErrorState({ title = "Could not load", error, onRetry }: { title?: string; error: unknown; onRetry?: () => void }) {
  return (
    <div className="panel p-5 flex items-start gap-3 border-red-500/20" data-testid="state-error">
      <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium">{title}</div>
        <div className="text-[12px] text-muted-foreground mono mt-0.5 break-words">{errMsg(error)}</div>
      </div>
      {onRetry && (
        <button onClick={onRetry} className="h-7 px-2.5 rounded-md border border-white/10 text-[12px] hover:bg-white/5 flex items-center gap-1.5" data-testid="button-retry">
          <RotateCw className="w-3 h-3" /> Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({ icon, title, desc, action }: { icon: ReactNode; title: string; desc: string; action?: ReactNode }) {
  return (
    <div className="panel grid-bg px-6 py-12 flex flex-col items-center text-center" data-testid="state-empty">
      <div className="w-10 h-10 rounded-lg border border-white/10 bg-[#09090B] flex items-center justify-center text-muted-foreground mb-3">{icon}</div>
      <div className="text-[14px] font-medium">{title}</div>
      <p className="text-[12.5px] text-muted-foreground mt-1 max-w-sm">{desc}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Sk({ className }: { className?: string }) {
  return <div className={cn("rounded-md bg-white/[0.04] animate-pulse", className)} />;
}

export function Stat({ label, value, sub, accent }: { label: string; value: ReactNode; sub?: ReactNode; accent?: "emerald" | "amber" }) {
  return (
    <div className="panel px-4 py-3.5">
      <div className="label-xs">{label}</div>
      <div className={cn("mono text-[22px] font-medium mt-1.5 tabular-nums", accent === "emerald" && "text-emerald-400", accent === "amber" && "text-amber-400")}>{value}</div>
      {sub && <div className="text-[11.5px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

export function ScoreBar({ label, value }: { label: string; value: number }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div>
      <div className="flex justify-between text-[11px] mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span className="mono tabular-nums">{v.toFixed(0)}</span>
      </div>
      <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
        <div className={cn("h-full rounded-full transition-transform origin-left", v >= 70 ? "bg-emerald-500" : v >= 45 ? "bg-amber-500" : "bg-zinc-500")} style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}

export const btn = {
  primary: "inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md bg-emerald-500 text-[#06130D] text-[12.5px] font-semibold hover:bg-emerald-400 active:scale-[.98] transition disabled:opacity-40 disabled:pointer-events-none",
  ghost: "inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md border border-white/[0.08] bg-white/[0.02] text-[12.5px] font-medium hover:bg-white/[0.06] hover:border-white/[0.14] active:scale-[.98] transition disabled:opacity-40 disabled:pointer-events-none",
  danger: "inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md border border-red-500/25 text-red-400 text-[12.5px] font-medium hover:bg-red-500/10 transition disabled:opacity-40",
  icon: "inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/[0.06] transition",
};

export const field = "w-full h-9 px-3 rounded-md bg-[#09090B] border border-white/[0.08] text-[13px] placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/10 transition";
