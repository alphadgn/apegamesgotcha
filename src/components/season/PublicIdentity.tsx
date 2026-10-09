// Public identity on leaderboards: only a deliberately chosen alias/avatar and an opaque public id.
// Never emails, wallet addresses or auth ids.

export const AVATARS = [
  { key: "ape-gold", label: "Gold", from: "#f6c343", to: "#d7262f" },
  { key: "ape-ocean", label: "Ocean", from: "#38bdf8", to: "#1e3a8a" },
  { key: "ape-jungle", label: "Jungle", from: "#4ade80", to: "#14532d" },
  { key: "ape-ember", label: "Ember", from: "#fb923c", to: "#7c2d12" },
  { key: "ape-violet", label: "Violet", from: "#b36bff", to: "#3b0764" },
  { key: "ape-night", label: "Night", from: "#94a3b8", to: "#0f172a" },
  { key: "ape-rose", label: "Rose", from: "#fb7185", to: "#881337" },
  { key: "ape-torch", label: "Torch", from: "#fde047", to: "#b45309" },
] as const;

export function publicName(alias: string | null | undefined, publicId: string | null | undefined) {
  return (
    alias?.trim() ||
    `Ape ${(publicId ?? "").replace(/-/g, "").slice(0, 6).toUpperCase() || "??????"}`
  );
}

export function PublicAvatar({
  avatarKey,
  alias,
  publicId,
  size = 32,
}: {
  avatarKey: string | null | undefined;
  alias: string | null | undefined;
  publicId: string | null | undefined;
  size?: number;
}) {
  const a =
    AVATARS.find((x) => x.key === avatarKey) ??
    AVATARS[Math.abs(hash(publicId ?? "")) % AVATARS.length]!;
  const letter = (alias?.trim()?.[0] ?? "A").toUpperCase();
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.45,
        background: `linear-gradient(135deg, ${a.from}, ${a.to})`,
      }}
    >
      {letter}
    </span>
  );
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** Points arrive as strings (bigint-safe). Format without converting to a JS number. */
export function formatPoints(v: string | number | null | undefined) {
  const s = v == null ? "0" : String(v);
  const neg = s.startsWith("-");
  const digits = neg ? s.slice(1) : s;
  return (neg ? "-" : "") + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
