// "Your gift certificates" on My Machine, and the choice a winner makes for each certificate:
//   • Redeem in person — a one-time code to show at the vendor; the vendor types it in the app.
//   • Claim the value — a request for the certificate's dollar value in APE, sent to the winner's default wallet
//     once an admin forwards it and the vendor pays (APE price at the moment of payment).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { chooseCertificate, getMyCertificates, type CertStatus } from "@/lib/certificates.functions";
import { Button } from "@/components/ui/button";

export const CERT_QUERY_KEY = ["my-certificates"] as const;

export function useMyCertificates(enabled = true) {
  const fn = useServerFn(getMyCertificates);
  return useQuery({ queryKey: CERT_QUERY_KEY, queryFn: () => fn(), enabled, staleTime: 15_000 });
}

export type MyCertificate = NonNullable<ReturnType<typeof useMyCertificates>["data"]>[number];

const STATUS: Record<CertStatus, { label: string; tone: string }> = {
  unclaimed: { label: "Choose how to use it", tone: "bg-destructive/20 text-destructive" },
  code_issued: { label: "Ready to redeem in person", tone: "bg-primary/20 text-primary" },
  redeemed: { label: "Redeemed", tone: "bg-muted text-muted-foreground" },
  requested: { label: "Value requested", tone: "bg-primary/20 text-primary" },
  forwarded: { label: "Sent to the vendor for payment", tone: "bg-primary/20 text-primary" },
  paid: { label: "Paid in APE", tone: "bg-muted text-muted-foreground" },
  cancelled: { label: "Cancelled", tone: "bg-muted text-muted-foreground" },
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The two choices and what happens next, for one certificate. */
export function CertificateChoice({ cert, onChanged }: { cert: MyCertificate; onChanged?: () => void }) {
  const qc = useQueryClient();
  const choose = useServerFn(chooseCertificate);
  const [busy, setBusy] = useState<"in_person" | "value" | null>(null);
  const changeable = cert.status === "unclaimed" || cert.status === "code_issued" || cert.status === "requested";

  const pick = async (choice: "in_person" | "value") => {
    setBusy(choice);
    try {
      await choose({ data: { id: cert.id, choice } });
      toast.success(choice === "in_person" ? "Your code is ready: show it at the vendor" : "Value requested: the team will send it to the vendor");
      await qc.invalidateQueries({ queryKey: CERT_QUERY_KEY });
      onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      {cert.status === "code_issued" && cert.code && (
        <div className="rounded-lg border border-primary bg-primary/10 p-4 text-center">
          <p className="text-xs uppercase text-muted-foreground">Your one-time code</p>
          <p className="mt-1 select-all font-mono text-3xl font-bold tracking-[0.25em]">{cert.code}</p>
          <p className="mt-2 text-sm">
            Show this code at <b>{cert.vendor}</b>
            {cert.location ? ` (${cert.location})` : ""}. They enter it in the app, and the certificate is used up.
          </p>
        </div>
      )}
      {cert.status === "requested" && (
        <p className="text-sm">
          You asked for the value: <b>${cert.valueUsd}</b> in APE to your wallet {cert.payoutWallet ? short(cert.payoutWallet) : ""}. The team
          forwards it to {cert.vendor}, who pays at the APE price at that moment.
        </p>
      )}
      {cert.status === "forwarded" && (
        <p className="text-sm">
          {cert.vendor} has your request and pays <b>${cert.valueUsd}</b> in APE to {cert.payoutWallet ? short(cert.payoutWallet) : "your wallet"}.
        </p>
      )}
      {cert.status === "paid" && (
        <p className="text-sm">
          Paid to {cert.payoutWallet ? short(cert.payoutWallet) : "your wallet"}.{" "}
          {cert.payTx && (
            <a className="underline" href={cert.payTx} target="_blank" rel="noreferrer">
              See the payment ↗
            </a>
          )}
        </p>
      )}
      {cert.status === "redeemed" && <p className="text-sm">Redeemed at {cert.vendor}. Enjoy!</p>}

      {changeable && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Button disabled={!!busy || cert.status === "code_issued"} onClick={() => void pick("in_person")}>
            {busy === "in_person" ? "…" : cert.status === "code_issued" ? "Code ready ✓" : "Redeem in person"}
          </Button>
          <Button variant="outline" disabled={!!busy || cert.status === "requested"} onClick={() => void pick("value")}>
            {busy === "value" ? "…" : cert.status === "requested" ? "Value requested ✓" : `Claim the value ($${cert.valueUsd} in APE)`}
          </Button>
        </div>
      )}
      {changeable && (
        <p className="text-xs text-muted-foreground">
          In person: use it at {cert.vendor}
          {cert.location ? `, ${cert.location}` : ""}. Value: ${cert.valueUsd} paid in APE (at the price when the vendor pays) to your
          default wallet. You can switch until it's used or sent to the vendor.
        </p>
      )}
    </div>
  );
}

export function GiftCertificates() {
  const { data, isLoading } = useMyCertificates();
  const [open, setOpen] = useState<string | null>(null);
  if (isLoading || !data?.length) return null;
  return (
    <section id="certificates" className="rounded border border-primary/60 bg-card p-4 text-left sm:p-6">
      <h2 className="text-xl font-bold">Your gift certificates</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Certificates from local businesses you won in on-chain draws. Redeem each one in person, or claim its value in APE.
      </p>
      <ul className="mt-4 space-y-3">
        {data.map((c) => {
          const st = STATUS[c.status];
          const needsChoice = c.status === "unclaimed";
          return (
            <li key={c.id} className="rounded border border-border p-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded bg-primary/15 text-2xl" aria-hidden>
                  🎟️
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-bold">
                    {c.prize} · ${c.valueUsd}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    From {c.vendor} · won {new Date(c.wonAt).toLocaleDateString()}
                  </p>
                  <span className={`mt-1 inline-block rounded px-2 py-0.5 text-xs font-bold ${st.tone}`}>{st.label}</span>
                </div>
                <Button size="sm" variant={needsChoice ? "default" : "outline"} onClick={() => setOpen(open === c.id ? null : c.id)}>
                  {open === c.id ? "Close" : needsChoice ? "Choose" : "Details"}
                </Button>
              </div>
              {(open === c.id || c.status === "code_issued") && (
                <div className="mt-3">
                  <CertificateChoice cert={c} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
