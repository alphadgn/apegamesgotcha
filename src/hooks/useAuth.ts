import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { getMyRole } from "@/lib/users.functions";

// One shared sign-in state for the whole app. The header, the pages, the guide and the wallet layer all call
// useAuth() at once; before, each call made its own network round trip (getUser + role lookups) and listened
// separately, so menus and pages popped in at different moments. Now the session is read once from local
// storage (instant), kept in sync by one listener, and the role is one cached server call shared by everyone.

type AuthState = { user: User | null; ready: boolean };
let state: AuthState = { user: null, ready: false };
const listeners = new Set<() => void>();
let started = false;

function set(next: AuthState) {
  if (next.user?.id === state.user?.id && next.ready === state.ready && next.user === state.user) return;
  state = next;
  listeners.forEach((l) => l());
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  void supabase.auth.getSession().then(({ data }) => set({ user: data.session?.user ?? null, ready: true }));
  // Keep the callback synchronous (Supabase warns against awaiting its own calls inside it).
  supabase.auth.onAuthStateChange((_event, session) => set({ user: session?.user ?? null, ready: true }));
}

function subscribe(l: () => void) {
  start();
  listeners.add(l);
  return () => listeners.delete(l);
}

const SERVER: AuthState = { user: null, ready: false };

/**
 * The signed-in player and their role. `isAdmin` is true for the super admin and promoted admins;
 * `isSuperAdmin` only for the super admin. (Only for showing the right screens — every admin action is
 * checked again on the server.)
 */
export function useAuth() {
  const { user, ready } = useSyncExternalStore(subscribe, () => state, () => SERVER);
  const role = useQuery({
    queryKey: ["my-role", user?.id ?? null],
    queryFn: () => getMyRole(),
    enabled: !!user,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const r = user ? role.data?.role : undefined;
  return {
    user,
    isAdmin: r === "admin" || r === "super",
    isSuperAdmin: r === "super",
    // Still finding out: the session, or (signed in) the role.
    loading: !ready || (!!user && role.isPending),
  };
}
