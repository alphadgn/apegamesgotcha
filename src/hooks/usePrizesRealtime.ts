import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Keeps every prize list in the app in sync with the database: when an admin
 * adds, edits, restocks or removes a prize, the homepage arcade, the machine
 * and the admin list all refresh within a moment, without a page reload.
 */
export function usePrizesRealtime() {
  const qc = useQueryClient();
  useEffect(() => {
    const channel = supabase
      .channel(`prizes-live-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "prizes" }, () => {
        void qc.invalidateQueries({ queryKey: ["public-prizes"] });
        void qc.invalidateQueries({ queryKey: ["machine"] });
        void qc.invalidateQueries({ queryKey: ["prizes-admin"] });
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [qc]);
}
