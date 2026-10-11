import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

/**
 * The signed-in player and their role. `isAdmin` is true for the super admin and promoted admins;
 * `isSuperAdmin` only for the super admin. (Only for showing the right screens — every admin action is
 * checked again on the server.)
 */
export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async (u: User | null) => {
      setUser(u);
      if (u) {
        const { data } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", u.id)
          .eq("role", "admin")
          .maybeSingle();
        const admin = !!data;
        let sup = false;
        if (admin) {
          // Untyped: super_admins arrives with drizzle 0009; before that every admin is the super admin.
          const db = supabase as unknown as SupabaseClient;
          const { data: s, error } = await db
            .from("super_admins")
            .select("user_id")
            .eq("user_id", u.id)
            .maybeSingle();
          sup = error ? true : !!s;
        }
        setIsAdmin(admin);
        setIsSuperAdmin(sup);
      } else {
        setIsAdmin(false);
        setIsSuperAdmin(false);
      }
      setLoading(false);
    };
    supabase.auth.getUser().then(({ data }) => load(data.user));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      void load(s?.user ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return { user, isAdmin, isSuperAdmin, loading };
}
