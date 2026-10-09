import { useState, type ReactNode } from "react";
import { toast } from "sonner";

export function Card({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="rounded border border-border bg-card p-4 text-left">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-bold">{title}</h3>
        {actions}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

export function KV({ k, v, warn }: { k: string; v: ReactNode; warn?: boolean | undefined }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border py-1.5 text-sm">
      <span className="text-muted-foreground">{k}</span>
      <span className={`text-right font-mono text-xs ${warn ? "text-destructive" : ""}`}>{v}</span>
    </div>
  );
}

export function QueryError({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="my-2 text-sm text-destructive">{(error as Error).message}</p>;
}

/** Runs an admin action with a busy flag and toasts. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async <T,>(key: string, fn: () => Promise<T>, ok?: (r: T) => string) => {
    setBusy(key);
    try {
      const r = await fn();
      toast.success(ok ? ok(r) : "Done");
      return r;
    } catch (e) {
      toast.error((e as Error).message);
      return undefined;
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

export function downloadText(name: string, text: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
