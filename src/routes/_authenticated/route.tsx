import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { PagePending } from "@/components/PagePending";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    // Local session check (instant): getUser() was a network round trip on every page change, which made
    // signed-in pages open late. The server and database still verify the token on every request.
    const { data } = await supabase.auth.getSession();
    const user = data.session?.user;
    if (!user) throw redirect({ to: "/auth" });
    return { user };
  },
  pendingComponent: PagePending,
  component: () => <Outlet />,
});
