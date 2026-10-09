// Deliberately chosen public avatars (fixed set — no uploads or external URLs on public pages).
const AVATAR_COLORS: Record<string, [string, string]> = {
  "ape-1": ["#f6c343", "#0c1b3d"],
  "ape-2": ["#d7262f", "#fff6e3"],
  "ape-3": ["#38bdf8", "#0c1b3d"],
  "ape-4": ["#b36bff", "#fff6e3"],
  "ape-5": ["#22c55e", "#0c1b3d"],
  "ape-6": ["#fb923c", "#0c1b3d"],
  "ape-7": ["#e5e7eb", "#0c1b3d"],
  "ape-8": ["#0ea5e9", "#fff6e3"],
};

export function PublicAvatar({
  avatarKey,
  publicId,
  size = 32,
}: {
  avatarKey: string | null | undefined;
  publicId: string;
  size?: number;
}) {
  const [bg, fg] = AVATAR_COLORS[avatarKey ?? ""] ?? ["#1e293b", "#94a3b8"];
  const label = avatarKey ? avatarKey.replace("ape-", "") : publicId.slice(-2).toUpperCase();
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <circle cx="16" cy="16" r="15" fill={bg} stroke="#f6c343" strokeWidth="1.5" />
      <circle cx="11" cy="13" r="2" fill={fg} />
      <circle cx="21" cy="13" r="2" fill={fg} />
      <path d="M10 21 Q16 25 22 21" stroke={fg} strokeWidth="2" fill="none" strokeLinecap="round" />
      {!avatarKey && (
        <text x="16" y="31" fontSize="7" textAnchor="middle" fill={fg} fontFamily="monospace">
          {label}
        </text>
      )}
    </svg>
  );
}

export const AVATAR_KEYS = Object.keys(AVATAR_COLORS);

export function publicName(alias: string | null | undefined, publicId: string) {
  return alias?.trim() || `Ape ${publicId.slice(-4).toUpperCase()}`;
}
