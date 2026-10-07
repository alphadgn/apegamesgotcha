// Email/password + Google sign-in through Supabase. Used only when Privy sign-in isn't available
// (no Privy App ID configured, or Privy failed to load).
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function EmailSignInForm({ onSignedIn }: { onSignedIn?: () => void }) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "up") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin + "/dashboard" },
        });
        if (error) throw error;
        toast.success("Check your email to confirm your account.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        onSignedIn?.();
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const google = async (): Promise<void> => {
    const r = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: window.location.origin,
    });
    if (r.error) {
      toast.error(r.error.message ?? "Google sign-in failed");
      return;
    }
    if (r.redirected) return;
    onSignedIn?.();
  };

  return (
    <div>
      <Button variant="outline" className="w-full" onClick={google}>
        Continue with Google
      </Button>
      <div className="my-5 text-center font-mono text-xs text-muted-foreground">or</div>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="pw">Password</Label>
          <Input
            id="pw"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <Button className="w-full" disabled={busy}>
          {mode === "in" ? "Sign in" : "Sign up"}
        </Button>
      </form>
      <button
        type="button"
        className="mt-5 w-full text-sm text-muted-foreground hover:text-foreground"
        onClick={() => setMode(mode === "in" ? "up" : "in")}
      >
        {mode === "in" ? "New here? Create an account" : "Have an account? Sign in"}
      </button>
    </div>
  );
}
