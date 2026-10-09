import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { setPublicProfile, linkXAccount, getShareSettings } from "@/lib/season.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AVATARS, publicName, PublicAvatar } from "@/components/season/PublicIdentity";
import { QueryError } from "@/components/season/SeasonBoard";

const db = supabase as unknown as SupabaseClient;

export const Route = createFileRoute("/_authenticated/profile")({
  head: () => ({
    meta: [
      { title: "Profile — ApeGames Gotcha" },
      { name: "description", content: "Choose how you appear on the ApeGames leaderboard." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Profile,
});

function Profile() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const saveFn = useServerFn(setPublicProfile);
  const linkXFn = useServerFn(linkXAccount);
  const shareFn = useServerFn(getShareSettings);
  const profile = useQuery({
    queryKey: ["my-profile", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await db
        .from("profiles")
        .select("public_id, public_alias, avatar_key")
        .eq("id", user!.id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data as {
        public_id: string;
        public_alias: string | null;
        avatar_key: string | null;
      } | null;
    },
  });
  const share = useQuery({
    queryKey: ["share-settings", user?.id],
    enabled: !!user,
    queryFn: () => shareFn(),
  });
  const [alias, setAlias] = useState("");
  const [avatar, setAvatar] = useState<string | null>(null);
  const [xHandle, setXHandle] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (profile.data) {
      setAlias(profile.data.public_alias ?? "");
      setAvatar(profile.data.avatar_key);
    }
  }, [profile.data]);

  const save = async () => {
    setBusy(true);
    try {
      await saveFn({ data: { alias: alias.trim() || null, avatarKey: avatar } });
      toast.success("Saved");
      void qc.invalidateQueries();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const linkX = async () => {
    setBusy(true);
    try {
      const r = await linkXFn({ data: { username: xHandle.trim() } });
      toast.success(`Linked @${r.username}`);
      setXHandle("");
      void share.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (profile.error)
    return (
      <main className="mx-auto max-w-xl px-4 py-12">
        <QueryError error={profile.error} onRetry={() => void profile.refetch()} />
      </main>
    );
  const p = profile.data;
  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <h1 className="text-4xl font-bold">Your public profile</h1>
      <p className="mt-2 text-muted-foreground">
        This is all other players see on the leaderboard. Your email, wallets and account id are
        never shown.
      </p>

      <section className="mt-6 rounded border border-border bg-card p-5">
        <div className="flex items-center justify-center gap-3">
          <PublicAvatar
            avatarKey={avatar}
            alias={alias || null}
            publicId={p?.public_id}
            size={56}
          />
          <span className="text-xl font-semibold">{publicName(alias || null, p?.public_id)}</span>
        </div>
        <label htmlFor="alias" className="mt-5 block text-sm text-muted-foreground">
          Leaderboard name (3–24 letters, numbers, spaces, . _ -). Leave empty to show an anonymous
          id.
        </label>
        <Input
          id="alias"
          className="mt-1"
          maxLength={24}
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          placeholder="e.g. BananaKing"
        />
        <p className="mt-4 text-sm text-muted-foreground">Avatar</p>
        <div
          className="mt-2 flex flex-wrap justify-center gap-2"
          role="radiogroup"
          aria-label="Avatar"
        >
          {AVATARS.map((a) => (
            <button
              key={a.key}
              type="button"
              role="radio"
              aria-checked={avatar === a.key}
              aria-label={a.label}
              onClick={() => setAvatar(a.key)}
              className={`rounded-full p-1 ${avatar === a.key ? "ring-2 ring-primary" : ""}`}
            >
              <PublicAvatar
                avatarKey={a.key}
                alias={alias || null}
                publicId={p?.public_id}
                size={40}
              />
            </button>
          ))}
        </div>
        <Button className="mt-5" onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </section>

      <section className="mt-6 rounded border border-border bg-card p-5">
        <h2 className="text-xl font-bold">X account (for verified shares)</h2>
        {share.data?.xAccount ? (
          <p className="mt-2">
            Linked: <b>@{share.data.xAccount.x_username}</b>
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">Not linked.</p>
        )}
        <p className="mt-2 text-sm text-muted-foreground">
          Enter your handle. We never ask for your X password: a share only counts when the post
          comes from this handle and shows your spin's share code.
          {share.data && !share.data.enabled && " Share rewards are off right now."}
        </p>
        <div className="mt-3 flex gap-2">
          <Input
            value={xHandle}
            onChange={(e) => setXHandle(e.target.value)}
            placeholder="@yourhandle"
            maxLength={16}
          />
          <Button variant="outline" onClick={() => void linkX()} disabled={busy || !xHandle.trim()}>
            Link
          </Button>
        </div>
      </section>

      <p className="mt-6 text-center text-sm">
        <Link to="/dashboard" className="text-primary underline">
          Wallets, NFTs and points →
        </Link>
      </p>
    </main>
  );
}
