import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { supabase } from "@/integrations/supabase/client";
import { SiteHeader } from "@/components/SiteHeader";
import { Toaster } from "@/components/ui/sonner";
import { PageArtwork } from "@/components/PageArtwork";
import artwork from "@/assets/apegames-event-collage.jpeg.asset.json";
import { PagePending } from "@/components/PagePending";
import { FloatingGuide } from "@/components/guide/GuideButton";
import { WalletHost } from "@/components/wallet/WalletHost";
import { RestockPopup } from "@/components/RestockPopup";
import { InactivityGuard } from "@/components/InactivityGuard";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "ApeGames Gotcha" },
      { name: "description", content: "Earn points, spin the gacha and climb the Go ApeGames 2026 leaderboard." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", sizes: "any" },
      { rel: "icon", type: "image/png", href: "/favicon.png" },
      // The app's two fonts load first (no Google Fonts stylesheet holding up the first paint), so text appears in
      // its final font with less jumping. Freaky Spooky = titles, Saira Semi Condensed = everything else.
      { rel: "preload", as: "font", type: "font/otf", href: "/__l5e/assets-v1/37ee4c58-7303-448c-9303-082e081d694c/freaky-spooky.otf", crossOrigin: "anonymous" },
      { rel: "preload", as: "font", type: "font/woff2", href: "/fonts/saira-semi-condensed/saira-semi-condensed-latin-400-normal.woff2", crossOrigin: "anonymous" },
      { rel: "preload", as: "font", type: "font/woff2", href: "/fonts/saira-semi-condensed/saira-semi-condensed-latin-700-normal.woff2", crossOrigin: "anonymous" },
      { rel: "preload", as: "image", href: artwork.url },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  pendingComponent: PagePending,
  errorComponent: ErrorComponent as any,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <PageArtwork />
        <div className="relative z-10 flex min-h-screen flex-col">{children}</div>
        <footer className="relative z-10 py-6 text-sm text-muted-foreground">
          © ApeGames 2026 · All rights reserved
        </footer>
        <Scripts />
      </body>
    </html>
  );
}

/** Each page fades in gently when it opens (no fade for people who turn motion off). */
function PageFade({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <div key={pathname} className="page-enter flex flex-1 flex-col">
      {children}
    </div>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      router.invalidate();
      if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
    });
    return () => data.subscription.unsubscribe();
  }, [router, queryClient]);

  // The wallet-link page opens inside a wallet app's browser, and the stock certificate claim page from an email:
  // show them on their own, without the site's menu, sign-in, guide or wallet windows.
  const pathname = useRouterState({ select: (st) => st.location.pathname });
  if (pathname === "/link-wallet" || pathname === "/claim-stock")
    return (
      <QueryClientProvider client={queryClient}>
        <Outlet />
        <Toaster theme="dark" />
      </QueryClientProvider>
    );

  return (
    <QueryClientProvider client={queryClient}>
      <SiteHeader />
      <PageFade>
        <Outlet />
      </PageFade>
      <FloatingGuide />
      <WalletHost />
      <RestockPopup />
      <InactivityGuard />
      <Toaster theme="dark" offset={{ bottom: 112 }} mobileOffset={{ bottom: 112 }} />
    </QueryClientProvider>
  );
}
