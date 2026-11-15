import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetPlaybook, getGetPlaybookQueryKey, useUpdateLesson } from "@workspace/api-client-react";
import { BookOpen, Check, Clock, PanelRightOpen } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useGuide } from "@/components/shell";
import { cn } from "@/lib/utils";
import { PageHeader, Sk, ErrorState, EmptyState, errMsg, btn } from "@/components/kit";

export default function Playbook() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const guide = useGuide();
  useEffect(() => { document.title = "Playbook · Veloce Engine"; }, []);
  const q = useGetPlaybook({ query: { queryKey: getGetPlaybookQueryKey() } });
  const upd = useUpdateLesson({ mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getGetPlaybookQueryKey() }), onError: (e) => toast({ title: "Could not save progress", description: errMsg(e), variant: "destructive" }) } });
  const [sel, setSel] = useState<number | null>(null);
  const lessons = q.data ?? [];
  const cats = useMemo(() => [...new Set(lessons.map((l) => l.category))], [lessons]);
  const current = lessons.find((l) => l.id === sel) ?? lessons.find((l) => !l.completed) ?? lessons[0];
  const done = lessons.filter((l) => l.completed).length;
  const pct = lessons.length ? (done / lessons.length) * 100 : 0;
  const mins = lessons.filter((l) => !l.completed).reduce((a, l) => a + l.minutes, 0);

  return (
    <div>
      <PageHeader eyebrow="05 / Playbook" title="Operator Training" desc="Short lessons on sourcing permission, writing hooks and packaging releases. Completion is saved to your workspace."
        actions={<button className={btn.ghost} onClick={guide.open} data-testid="button-open-guide-page"><PanelRightOpen className="w-3.5 h-3.5" /> Open as slide-over</button>} />
      {q.isLoading ? <div className="grid lg:grid-cols-[320px_1fr] gap-5"><Sk className="h-96" /><Sk className="h-96" /></div>
        : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : !lessons.length ? <EmptyState icon={<BookOpen className="w-4 h-4" />} title="No lessons published" desc="Training modules will appear here." />
        : (
        <div className="grid lg:grid-cols-[320px_1fr] gap-5">
          <div className="space-y-4">
            <div className="panel p-4">
              <div className="flex items-end justify-between"><div><div className="label-xs">Progress</div><div className="mono text-[26px] mt-1">{done}<span className="text-zinc-600">/{lessons.length}</span></div></div><div className="mono text-[11px] text-zinc-500 text-right">{mins} min<br />remaining</div></div>
              <div className="h-1 rounded-full bg-white/[0.06] mt-3 overflow-hidden"><div className="h-full bg-emerald-500 transition-all duration-500" style={{ width: `${pct}%` }} /></div>
            </div>
            {cats.map((c) => (
              <div key={c}>
                <div className="label-xs mb-1.5 px-1">{c}</div>
                <div className="panel p-1">{lessons.filter((l) => l.category === c).map((l) => (
                  <button key={l.id} onClick={() => setSel(l.id)} data-testid={`button-lesson-${l.id}`} className={cn("w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left transition", current?.id === l.id ? "bg-white/[0.06]" : "hover:bg-white/[0.03]")}>
                    <span className={cn("w-4 h-4 rounded-full border flex items-center justify-center shrink-0", l.completed ? "bg-emerald-500 border-emerald-500 text-[#06130D]" : "border-white/20")}>{l.completed && <Check className="w-2.5 h-2.5" strokeWidth={3} />}</span>
                    <span className={cn("text-[12.5px] flex-1 truncate", l.completed && "text-zinc-500")}>{l.title}</span>
                    <span className="mono text-[10.5px] text-zinc-600">{l.minutes}m</span>
                  </button>))}</div>
              </div>))}
          </div>
          {current && (
            <article className="panel p-5 md:p-8 rise" key={current.id}>
              <div className="flex items-center gap-2 mono text-[11px] text-zinc-500 uppercase tracking-wider"><span>{current.category}</span><span>·</span><Clock className="w-3 h-3" />{current.minutes} min</div>
              <h2 className="text-[20px] font-semibold tracking-tight mt-2">{current.title}</h2>
              <div className="mt-5 text-[14px] leading-[1.75] text-zinc-300 whitespace-pre-line max-w-[68ch]">{current.content}</div>
              <div className="mt-8 pt-5 border-t border-white/[0.06] flex items-center gap-3">
                <button className={current.completed ? btn.ghost : btn.primary} disabled={upd.isPending} onClick={() => upd.mutate({ id: current.id, data: { completed: !current.completed } })} data-testid="button-toggle-lesson">
                  <Check className="w-3.5 h-3.5" /> {current.completed ? "Mark incomplete" : "Mark complete"}
                </button>
                {current.completed && <span className="text-[12px] text-emerald-400">Completed</span>}
              </div>
            </article>)}
        </div>)}
    </div>
  );
}
