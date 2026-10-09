import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getShareSettings, submitShare } from "@/lib/identity.functions";
import { useAuth } from "@/hooks/useAuth";

/**
 * Earn the share bonus with a VERIFIED X post. Posting or clicking alone never earns anything: the
 * post must be by the player's linked X account, reference this spin, and pass API or manual review.
 * Hidden entirely while share rewards are disabled.
 */
export function VerifiedShareForm({ spinId }: { spinId: string }) {
  const { user } = useAuth();
  const settingsFn = useServerFn(getShareSettings);
  const submitFn = useServerFn(submitShare);
  const qc = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ["share-settings"],
    queryFn: () => settingsFn(),
    staleTime: 60_000,
    enabled: !!user,
  });
  const [url, setUrl] = useState("");
  const [state, setState] = useState<{ kind: "idle" | "busy" | "done" | "error"; text?: string }>({
    kind: "idle",
  });
  if (!user || !settings?.enabled) return null;

  const submit = async () => {
    setState({ kind: "busy" });
    try {
      const r = await submitFn({ data: { postUrl: url.trim(), spinId } });
      const text =
        r.status === "approved"
          ? `Verified! +${settings.points} points.`
          : r.status === "pending"
            ? "Submitted — waiting for verification. You'll see it in My Machine."
            : r.status === "not_rewarded"
              ? "Verified, but today's share reward was already earned (or this spin was shared before)."
              : "This post couldn't be verified.";
      setState({ kind: "done", text });
      void qc.invalidateQueries({ queryKey: ["my-shares"] });
    } catch (e) {
      setState({ kind: "error", text: (e as Error).message });
    }
  };

  return (
    <div className="gm-rf-verify">
      <p className="gm-rf-label">
        Earn +{settings.points} — post this result on X from your linked account, then paste the
        post link (max {settings.perDay}/day, verified
        {settings.mode === "manual" ? " by our team" : ""}).
      </p>
      <div className="gm-rf-verify-row">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://x.com/you/status/…"
          inputMode="url"
          aria-label="Link to your X post"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={state.kind === "busy" || !url.trim()}
        >
          {state.kind === "busy" ? "Checking…" : "Verify post"}
        </button>
      </div>
      {state.text && (
        <p className={state.kind === "error" ? "gm-rf-error" : "gm-rf-status"}>{state.text}</p>
      )}
    </div>
  );
}
