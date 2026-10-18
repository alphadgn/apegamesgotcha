// "Have a code?" — a signed-in player types or pastes a free-spin code. Shown in the Refill window and on My Machine.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { redeemSpinCode } from "@/lib/codes.functions";

export function RedeemCode({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient();
  const redeem = useServerFn(redeemSpinCode);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await redeem({ data: { code } });
      const what = `${r.spins} ${r.kind === "demo" ? "demo " : "free "}spin${r.spins === 1 ? "" : "s"}`;
      setMsg({ ok: true, text: `Code redeemed: ${what} added to your machine.` });
      toast.success(`${what} added`);
      setCode("");
      void qc.invalidateQueries();
    } catch (err) {
      const m = (err as Error).message;
      setMsg({ ok: false, text: m.trim().startsWith("[") ? "Enter the code." : m });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={submit}
      className={
        compact
          ? "mt-4 border-t border-white/15 pt-3"
          : "rounded border border-primary/60 bg-card p-4 text-left sm:p-6"
      }
    >
      <label
        className={compact ? "block text-sm font-bold" : "block text-xl font-bold"}
        htmlFor={compact ? "redeem-code-c" : "redeem-code"}
      >
        Have a free-spin code?
      </label>
      <div className="mt-2 flex gap-2">
        <input
          id={compact ? "redeem-code-c" : "redeem-code"}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="e.g. 3fa9c01b7e"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={40}
          className="min-h-11 min-w-0 flex-1 rounded border border-input bg-background px-3 font-mono text-base text-foreground"
        />
        <button
          type="submit"
          disabled={busy || !code.trim()}
          className="min-h-11 rounded px-4 font-bold disabled:opacity-60"
          style={{ backgroundColor: "#f6c343", color: "#141414" }}
        >
          {busy ? "…" : "Redeem"}
        </button>
      </div>
      {msg && (
        <p className={`mt-2 text-sm ${msg.ok ? "text-primary" : "text-destructive"}`} role="status">
          {msg.text}
        </p>
      )}
    </form>
  );
}
