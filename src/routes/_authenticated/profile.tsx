import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getMyProfile, linkXAccount, setPublicProfile } from "@/lib/identity.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PublicAvatar, publicName } from "@/components/season/PublicAvatar";

export const Route = createFileRoute("/_authenticated/profile")({
  head: () => ({
    meta: [
      { title: "Profile — ApeGames Gotcha" },
      { name: "description", content: "Your public name, avatar, wallets and X account." },
    ],
  }),
  component: ProfilePage,
});

function ProfilePage() {
  const fn = useServerFn(getMyProfile);
  const saveFn = useServerFn(setPublicProfile);
  const xFn = useServerFn(linkXAccount);
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ["my-profile"], queryFn: () => fn() });
  const [alias, setAlias] = useState("");
  const [avatar, setAvatar] = useState<string | null>(null);
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data?.profile) return;
    setAlias(data.profile.public_alias ?? "");
    setAvatar(data.profile.avatar_key ?? null);
  }, [data?.profile]);

  if (error)
    return (
      <main className="mx-auto max-w-xl px-4 py-12 text-destructive">
        {(error as Error).message}
      </main>
    );
  if (!data)
    return (
      <main className="mx-auto max-w-xl px-4 py-12 font-mono text-muted-foreground">Loading…</main>
    );

  const save = async () => {
    setBusy(true);
    try {
      await saveFn({
        data: {
          alias: alias.trim() || null,
          avatar: (avatar as (typeof data.avatars)[number] | null) ?? null,
        },
      });
      toast.success("Public profile saved");
      await qc.invalidateQueries();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <h1 className="text-3xl font-bold">Profile</h1>

      <section className="mt-6 rounded border border-border bg-card p-6 text-left">
        <h2 className="text-xl font-bold">Public name on the leaderboard</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Only what you choose here is public. Without an alias you appear as “
          {publicName(null, data.profile.public_id)}”. Your email and wallets are never shown.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <PublicAvatar avatarKey={avatar} publicId={data.profile.public_id} size={48} />
          <div className="flex-1">
            <Label htmlFor="alias">Alias (3–24 characters)</Label>
            <Input
              id="alias"
              value={alias}
              maxLength={24}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="Leave empty to stay anonymous"
            />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setAvatar(null)}
            className={`rounded border p-1 ${avatar == null ? "border-primary" : "border-border"}`}
            aria-label="No avatar"
          >
            <PublicAvatar avatarKey={null} publicId={data.profile.public_id} size={36} />
          </button>
          {data.avatars.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setAvatar(a)}
              className={`rounded border p-1 ${avatar === a ? "border-primary" : "border-border"}`}
              aria-label={a}
            >
              <PublicAvatar avatarKey={a} publicId={data.profile.public_id} size={36} />
            </button>
          ))}
        </div>
        <Button className="mt-4" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <p className="mt-3 font-mono text-[10px] text-muted-foreground">
          Public id: {data.profile.public_id}
        </p>
      </section>

      <section className="mt-6 rounded border border-border bg-card p-6 text-left">
        <h2 className="text-xl font-bold">X account</h2>
        {data.x ? (
          <p className="mt-2 text-sm">
            Linked: <b>@{data.x.handle}</b> (
            {data.x.verification_method === "oauth"
              ? "verified by X"
              : "checked during share review"}
            )
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            Link the X account you post from. Only posts by this account can earn the verified-share
            bonus. We never ask for your X password.
          </p>
        )}
        <div className="mt-3 flex gap-2">
          <Input
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="@yourhandle"
          />
          <Button
            variant="outline"
            disabled={busy || !handle.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await xFn({ data: { handle: handle.trim() } });
                toast.success("X account linked");
                setHandle("");
                await qc.invalidateQueries({ queryKey: ["my-profile"] });
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {data.x ? "Replace" : "Link"}
          </Button>
        </div>
      </section>

      <section className="mt-6 rounded border border-border bg-card p-6 text-left">
        <h2 className="text-xl font-bold">Wallets</h2>
        <ul className="mt-2 space-y-1 font-mono text-xs">
          {data.wallets.map((w) => (
            <li key={w.id as string} className="break-all">
              {w.address as string}
              {w.is_default ? " · default" : ""}
              {w.is_contract ? " · contract" : ""}
            </li>
          ))}
          {!data.wallets.length && (
            <li className="text-muted-foreground">No verified wallets yet.</li>
          )}
        </ul>
        <Link to="/dashboard" className="mt-3 inline-block text-sm underline">
          Manage wallets in My Machine
        </Link>
      </section>
    </main>
  );
}
