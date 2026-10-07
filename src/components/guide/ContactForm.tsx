import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { submitContact, contactSchema } from "@/lib/contact.functions";

export function ContactForm({ defaultEmail = "", onDone }: { defaultEmail?: string; onDone?: () => void }) {
  const send = useServerFn(submitContact);
  const [form, setForm] = useState({ name: "", email: defaultEmail, message: "", website: "" });
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = contactSchema.safeParse(form);
    if (!parsed.success) return toast.error(parsed.error.issues[0]?.message ?? "Check the form");
    setBusy(true);
    try {
      await send({ data: parsed.data });
      setSent(true);
    } catch (err) {
      toast.error((err as Error).message || "Couldn't send your message");
    } finally {
      setBusy(false);
    }
  };

  if (sent)
    return (
      <div className="rounded border border-border bg-card/80 p-4 text-sm">
        Thanks — your message reached the ApeGames team.{" "}
        <button type="button" className="text-primary underline" onClick={onDone}>Back to the guide</button>
      </div>
    );

  const field = "w-full rounded border border-border bg-background px-3 py-2 text-sm";
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded border border-border bg-card/80 p-4">
      <p className="text-sm text-muted-foreground">Ask the ApeGames team directly — no sign-in needed.</p>
      <input className={field} placeholder="Your name" maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <input className={field} type="email" placeholder="Your email" maxLength={255} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      <textarea className={`${field} min-h-24`} placeholder="Your question" maxLength={2000} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
      <input type="text" tabIndex={-1} autoComplete="off" aria-hidden className="hidden" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
      <div className="flex justify-end gap-2">
        {onDone && <button type="button" className="rounded border border-border px-3 py-1 text-sm" onClick={onDone}>Cancel</button>}
        <button type="submit" disabled={busy} className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground">{busy ? "Sending…" : "Send"}</button>
      </div>
    </form>
  );
}
