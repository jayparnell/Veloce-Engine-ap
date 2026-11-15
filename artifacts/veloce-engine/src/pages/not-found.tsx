import { Link } from "wouter";
import { btn } from "@/components/kit";

export default function NotFound() {
  return (
    <div className="min-h-[60dvh] flex flex-col items-center justify-center text-center grid-bg rounded-xl">
      <div className="mono text-[11px] text-zinc-500 tracking-widest">ERR 404</div>
      <h1 className="text-[22px] font-semibold mt-2">No module at this route</h1>
      <p className="text-[13px] text-muted-foreground mt-1">The page you requested does not exist in this workspace.</p>
      <Link href="/" className={`${btn.primary} mt-5`}>Back to Studio</Link>
    </div>
  );
}
