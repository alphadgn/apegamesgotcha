import { formatPoints, type SeasonRules } from "@/lib/seasonRules";

type Projection = {
  expectedBonus: string;
  expectedTotal: string;
  participation: string;
  odds: { name: string; rarity: string; probability: number; bonus: string }[];
} | null;

const utc = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("en-US", {
        timeZone: "UTC",
        dateStyle: "medium",
        timeStyle: "short",
      }) + " UTC"
    : "not set";

/** Published, frozen season rules plus honest context about what drives rank. */
export function SeasonRulesPanel({
  rules,
  startsAt,
  endsAt,
  deadline,
  graceHours,
  rulesHash,
  projection,
}: {
  rules: SeasonRules;
  startsAt: string | null;
  endsAt: string | null;
  deadline: string | null;
  graceHours: number;
  rulesHash: string | null;
  projection?: Projection;
}) {
  const p = rules.points;
  return (
    <section className="rounded border border-border bg-card/90 p-5 text-left text-sm">
      <h2 className="text-xl font-bold">Season rules</h2>
      <dl className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
        <Row k="Starts" v={utc(startsAt)} />
        <Row k="Cutoff (exclusive)" v={utc(endsAt)} />
        <Row k="Settlement deadline" v={utc(deadline)} />
        <Row k="Verification grace period" v={`${graceHours} hours after the cutoff`} />
      </dl>
      <h3 className="mt-4 font-bold">Points</h3>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {p.nft_snapshot_per_token !== "0" && (
          <li>
            {formatPoints(p.nft_snapshot_per_token)} once per eligible 2025 NFT held at the frozen
            historical snapshot (claimed with a verified wallet; buying one later doesn't count).
          </li>
        )}
        <li>
          {formatPoints(p.participation_per_spin)} per fulfilled spin (paid, burn, grant and free
          spins count the same). Pending, refunded and “no prize” spins score 0.
        </li>
        <li>
          Prize bonus: common {formatPoints(p.rarity_bonus.common)}, rare{" "}
          {formatPoints(p.rarity_bonus.rare)}, epic {formatPoints(p.rarity_bonus.epic)}, legendary{" "}
          {formatPoints(p.rarity_bonus.legendary)}
          {Object.keys(p.prize_bonus_overrides ?? {}).length
            ? " (some prizes have their own bonus)"
            : ""}
          .
        </li>
        {p.x_share !== "0" && (
          <li>
            {formatPoints(p.x_share)} for a verified X post of one of your results, at most{" "}
            {rules.limits.x_shares_per_utc_day} per UTC day. Posting alone isn't enough — it must be
            verified.
          </li>
        )}
        <li>
          Limits: {rules.limits.spins_rolling_24h} spins per rolling 24 hours,{" "}
          {rules.limits.spins_per_season} per season. Referrals: off.
        </li>
        <li>
          A draw counts for the season only if its Chainlink request is confirmed on-chain before
          the cutoff. Prizes are always delivered, even when a draw lands too late to score.
        </li>
      </ul>
      {projection && (
        <p className="mt-3 rounded bg-muted/50 p-3">
          With the prizes available right now, a spin averages about{" "}
          <b>{projection.expectedBonus}</b> bonus + <b>{projection.participation}</b> participation
          = <b>{projection.expectedTotal}</b> points. Prize stock is finite: as prizes run out the
          odds — and this average — change.
        </p>
      )}
      <h3 className="mt-4 font-bold">How rank works</h3>
      <p className="mt-1">
        Highest total first; ties go to whoever reached that total first, then a stable player
        order. Snapshot holdings, how much you play, and random prize bonuses all influence rank.
      </p>
      <p className="mt-3 text-xs text-muted-foreground">
        Points are nontransferable engagement scores. They have no guaranteed dollar, APE or $GAMES
        value and are not paid out or redeemable. Any leaderboard prizes would be published
        separately, in advance, with fixed funding and tie rules.
      </p>
      {rulesHash && (
        <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">
          Rules hash: {rulesHash}
        </p>
      )}
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/50 py-1">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-right font-mono text-xs">{v}</dd>
    </div>
  );
}
