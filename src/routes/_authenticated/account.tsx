import { createFileRoute, Link } from "@tanstack/react-router";
import { PagePending } from "@/components/PagePending";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { checkUsername, getAvatarUploadUrl, getMyProfile, setMyAvatar, updateMyProfile, USERNAME_TAKEN, usernameSchema } from "@/lib/users.functions";
import { Avatar } from "@/components/Avatar";
import { VendorArea } from "@/components/VendorArea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/_authenticated/account")({
  head: () => ({
    meta: [
      { title: "My account — ApeGames Gotcha" },
      { name: "description", content: "Your ApeGames Gotcha username and profile picture." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccountPage,
});

const ROLE_LABEL = { super: "Super admin", admin: "Admin", user: "Player" } as const;
const MAX_BYTES = 3 * 1024 * 1024;

/** The signed-in player's own account: username and profile picture (uploaded from their device). */
function AccountPage() {
  const qc = useQueryClient();
  const profileFn = useServerFn(getMyProfile);
  const saveFn = useServerFn(updateMyProfile);
  const avatarFn = useServerFn(setMyAvatar);
  const uploadUrlFn = useServerFn(getAvatarUploadUrl);
  const checkFn = useServerFn(checkUsername);
  const { data: me, isLoading } = useQuery({
    queryKey: ["my-profile"],
    queryFn: () => profileFn(),
  });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"name" | "picture" | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (me) setName(me.displayName ?? "");
  }, [me]);

  // Live check while typing: is this username already someone else's?
  const [taken, setTaken] = useState<string | null>(null);
  const unchanged = name.trim().toLowerCase() === (me?.displayName ?? "").trim().toLowerCase();
  useEffect(() => {
    const parsed = usernameSchema.safeParse(name);
    if (!me || unchanged || !parsed.success) return void setTaken(null);
    let live = true;
    const t = setTimeout(() => {
      checkFn({ data: { displayName: parsed.data } }).then(
        (r) => live && setTaken(r.available ? null : parsed.data),
        () => undefined, // the save itself checks again
      );
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [name, me, unchanged, checkFn]);
  const isTaken = !!taken && taken.toLowerCase() === name.trim().toLowerCase();

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["my-profile"] });
    void qc.invalidateQueries({ queryKey: ["leaderboard"] });
    void qc.invalidateQueries({ queryKey: ["avatar"] });
  };

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = usernameSchema.safeParse(name);
    if (!parsed.success)
      return void toast.error(parsed.error.issues[0]?.message ?? "Check your username");
    if (isTaken) return void toast.error(USERNAME_TAKEN);
    setBusy("name");
    try {
      await saveFn({ data: { displayName: parsed.data } });
      toast.success("Username saved");
      refresh();
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === USERNAME_TAKEN) setTaken(parsed.data);
      toast.error(msg);
    } finally {
      setBusy(null);
    }
  };

  const upload = async (f: File) => {
    if (!/^image\/(jpeg|png|webp|gif)$/.test(f.type))
      return void toast.error("Use a JPEG, PNG, WebP or GIF picture");
    if (f.size > MAX_BYTES) return void toast.error("Pictures must be under 3 MB");
    setBusy("picture");
    try {
      const ext = (f.type.split("/")[1] === "jpeg" ? "jpg" : f.type.split("/")[1]) as "jpg" | "png" | "webp" | "gif";
      // The server makes a one-time upload link into your own folder (and sets up picture storage if needed).
      const { path, token } = await uploadUrlFn({ data: { ext } });
      const { error } = await supabase.storage
        .from("avatars")
        .uploadToSignedUrl(path, token, f, { contentType: f.type });
      if (error) throw new Error(error.message);
      await avatarFn({ data: { path } });
      toast.success("Profile picture updated");
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const removePicture = async () => {
    setBusy("picture");
    try {
      await avatarFn({ data: { path: null } });
      toast.success("Profile picture removed");
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (isLoading || !me)
    return <PagePending />;

  return (
    <main className="mx-auto max-w-xl px-4 py-8 sm:py-12">
      <div className="rounded border border-border bg-card p-5 sm:p-7">
        <h1 className="text-3xl font-bold">My account</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {ROLE_LABEL[me.role]}
          {me.memberSince ? ` · member since ${new Date(me.memberSince).toLocaleDateString()}` : ""}
        </p>

        <section className="mt-6 flex flex-wrap items-center gap-4">
          <Avatar path={me.avatarPath} name={me.displayName ?? me.email} size={96} />
          <div className="grid gap-2">
            <input
              ref={file}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void upload(f);
              }}
            />
            <Button type="button" onClick={() => file.current?.click()} disabled={!!busy}>
              {busy === "picture"
                ? "Uploading…"
                : me.avatarPath
                  ? "Change picture"
                  : "Upload picture"}
            </Button>
            {me.avatarPath && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void removePicture()}
                disabled={!!busy}
              >
                Remove picture
              </Button>
            )}
            <p className="text-xs text-muted-foreground">JPEG, PNG, WebP or GIF, up to 3 MB.</p>
          </div>
        </section>

        <form onSubmit={saveName} className="mt-6 grid gap-2">
          <label htmlFor="username" className="text-sm font-bold">
            Username
          </label>
          <div className="flex gap-2">
            <Input
              id="username"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={24}
              autoComplete="nickname"
              aria-invalid={isTaken}
              aria-describedby={isTaken ? "username-taken" : undefined}
              className={isTaken ? "border-destructive focus-visible:ring-destructive" : undefined}
            />
            <Button type="submit" disabled={!!busy || isTaken || name.trim() === (me.displayName ?? "")}>
              {busy === "name" ? "Saving…" : "Save"}
            </Button>
          </div>
          {isTaken && (
            <p id="username-taken" role="alert" className="text-sm font-medium text-destructive">
              {USERNAME_TAKEN}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Shown on the leaderboard. Each username belongs to one player. 3–24 letters, numbers, spaces, dots, dashes or underscores.
          </p>
        </form>

        {me.email && (
          <p className="mt-6 text-sm text-muted-foreground">
            Signed in as <span className="break-all">{me.email}</span>
          </p>
        )}
        <p className="mt-4 text-sm">
          <Link to="/dashboard" className="underline">
            Wallets, NFTs and spins are on My Machine
          </Link>
        </p>

        <VendorArea />
      </div>
    </main>
  );
}
