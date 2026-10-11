import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { openSignIn } from "@/components/wallet/walletUi";
import {
  ArrowLeft,
  Menu,
  Trophy,
  Gamepad2,
  MessageCircle,
  Shield,
  LogIn,
  LogOut,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

/**
 * Back arrow on every page except home: returns to the previous page in the app, and to the home page
 * when there's nothing to go back to (the page was opened directly or from another site).
 */
function BackButton() {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (pathname === "/") return null;
  const back = () => {
    if (router.history.canGoBack()) router.history.back();
    else void router.navigate({ to: "/" });
  };
  return (
    <Button
      variant="outline"
      size="icon"
      className="absolute left-4 shrink-0"
      onClick={back}
      aria-label="Go back"
      title="Back"
    >
      <ArrowLeft aria-hidden="true" />
    </Button>
  );
}

export function SiteHeader() {
  const { user, isAdmin } = useAuth();
  const router = useRouter();
  const link = "min-h-11 cursor-pointer text-sm uppercase text-muted-foreground";
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
      <div className="relative mx-auto flex h-14 max-w-6xl items-center justify-center px-16">
        <BackButton />
        <Link
          to="/"
          className="site-title inline-flex min-h-11 min-w-0 items-center truncate whitespace-nowrap font-display text-base font-bold sm:text-lg uppercase tracking-wide"
        >
          ApeGames Gotcha
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="absolute right-4 shrink-0"
              aria-label="Open navigation menu"
              title="Navigation menu"
            >
              <Menu aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={8} className="w-52" aria-label="Navigation">
            <DropdownMenuItem asChild className={link}>
              <Link to="/leaderboard" activeProps={{ className: "text-primary" }}>
                <Trophy aria-hidden="true" />
                Leaderboard
              </Link>
            </DropdownMenuItem>
            {user && (
              <>
                <DropdownMenuItem asChild className={link}>
                  <Link to="/dashboard" activeProps={{ className: "text-primary" }}>
                    <Gamepad2 aria-hidden="true" />
                    My Machine
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild className={link}>
                  <Link to="/guide" activeProps={{ className: "text-primary" }}>
                    <MessageCircle aria-hidden="true" />
                    Guide
                  </Link>
                </DropdownMenuItem>
              </>
            )}
            {isAdmin && (
              <DropdownMenuItem asChild className={link}>
                <Link to="/admin" activeProps={{ className: "text-primary" }}>
                  <Shield aria-hidden="true" />
                  Admin
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            {user ? (
              <DropdownMenuItem
                className={link}
                onSelect={async () => {
                  await supabase.auth.signOut();
                  void router.navigate({ to: "/" });
                }}
              >
                <LogOut aria-hidden="true" />
                Sign out
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem className={link} onSelect={() => openSignIn()}>
                <LogIn aria-hidden="true" />
                Sign in
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
