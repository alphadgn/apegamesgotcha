import { Link, useRouter } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";

export function SiteHeader() {
  const { user, isAdmin } = useAuth();
  const router = useRouter();
  const link = "text-sm font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground";
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
        <Link to="/" className="font-display text-lg font-bold uppercase tracking-wide">
          Ape<span className="text-primary">Games</span> Gotcha
        </Link>
        <nav className="flex flex-1 items-center gap-5">
          <Link to="/leaderboard" className={link} activeProps={{ className: "text-primary" }}>Leaderboard</Link>
          {user && <Link to="/dashboard" className={link} activeProps={{ className: "text-primary" }}>My Machine</Link>}
          {user && <Link to="/guide" className={link} activeProps={{ className: "text-primary" }}>Guide</Link>}
          {isAdmin && <Link to="/admin" className={link} activeProps={{ className: "text-primary" }}>Admin</Link>}
        </nav>
        {user ? (
          <Button variant="outline" size="sm" onClick={async () => { await supabase.auth.signOut(); router.navigate({ to: "/" }); }}>
            Sign out
          </Button>
        ) : (
          <Button asChild size="sm"><Link to="/auth">Sign in</Link></Button>
        )}
      </div>
    </header>
  );
}
