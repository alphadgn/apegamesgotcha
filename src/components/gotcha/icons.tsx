// Inline SVG art for the Gotcha machine. No external assets.
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

export function CoinsIcon(p: P) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden {...p}>
      <defs>
        <linearGradient id="gm-coin" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#ffe28a" />
          <stop offset="1" stopColor="#c98a17" />
        </linearGradient>
      </defs>
      {[40, 32, 24, 16].map((y, i) => (
        <g key={y}>
          <ellipse cx={i === 3 ? 30 : 32} cy={y + 6} rx="20" ry="7" fill="#8a5a0c" />
          <rect x={i === 3 ? 10 : 12} y={y} width="40" height="6" fill="url(#gm-coin)" />
          <ellipse cx={i === 3 ? 30 : 32} cy={y} rx="20" ry="7" fill="#ffd862" stroke="#b27a14" strokeWidth="1.5" />
        </g>
      ))}
      <ellipse cx="30" cy="16" rx="11" ry="3.5" fill="none" stroke="#b27a14" strokeWidth="1.5" />
    </svg>
  );
}

export function CrateIcon({ tone = "gold", ...p }: P & { tone?: "gold" | "silver" }) {
  const c = tone === "gold" ? ["#ffd65c", "#c1841a", "#7a4d0b"] : ["#e8eef7", "#9aa9bf", "#4d5b72"];
  return (
    <svg viewBox="0 0 64 64" aria-hidden {...p}>
      <path d="M8 22 32 12l24 10v26L32 58 8 48z" fill={c[1]} />
      <path d="M8 22 32 32l24-10L32 12z" fill={c[0]} />
      <path d="M32 32v26L8 48V22z" fill={c[1]} />
      <path d="M32 32v26l24-10V22z" fill={c[2]} opacity=".85" />
      <path d="M20 17l24 10v8l-6 2v-8L14 19z" fill="#d7262f" />
      <path d="M8 22 32 32l24-10M32 32v26" fill="none" stroke="#0c1b3d" strokeOpacity=".35" strokeWidth="1.5" />
      <text x="44" y="46" textAnchor="middle" fontFamily="Oswald, sans-serif" fontWeight="700" fontSize="14" fill="#fff6e3">?</text>
    </svg>
  );
}

export function TicketIcon(p: P) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden {...p}>
      <g transform="rotate(-18 32 32)">
        <path d="M6 20h52v8a4 4 0 0 0 0 8v8H6v-8a4 4 0 0 0 0-8z" fill="#d7262f" stroke="#8f1117" strokeWidth="2" />
        <path d="M44 22v20" stroke="#fff6e3" strokeDasharray="3 3" strokeWidth="1.5" />
        <path d="M22 26v14M22 26c-5 1-8 4-9 7M22 26c5 0 8 2 10 5M22 26c-3-2-7-2-9 0M22 26c3-3 7-3 9-1" stroke="#fff6e3" strokeWidth="2" fill="none" strokeLinecap="round" />
        <text x="51" y="36" textAnchor="middle" fontFamily="Oswald, sans-serif" fontWeight="700" fontSize="8" fill="#ffd862">VIP</text>
      </g>
    </svg>
  );
}

export function CapIcon(p: P) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden {...p}>
      <path d="M10 40c0-15 10-26 23-26s22 10 22 24z" fill="#13295a" stroke="#07122e" strokeWidth="2" />
      <path d="M8 40c10 3 34 4 50-2 2 4-2 8-8 9-14 2-32 1-42-3z" fill="#0c1b3d" />
      <circle cx="33" cy="14" r="3" fill="#0c1b3d" />
      <text x="33" y="33" textAnchor="middle" fontFamily="Oswald, sans-serif" fontWeight="700" fontSize="8" fill="#fff6e3">APE 26</text>
    </svg>
  );
}

export function ShirtIcon(p: P) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden {...p}>
      <path d="M22 8 8 16l5 12 7-3v31h24V25l7 3 5-12-14-8c-2 5-6 7-10 7s-8-2-10-7z" fill="#fff6e3" stroke="#9aa9bf" strokeWidth="2" />
      <path d="M32 26c-3 3-3 6 0 8 3-2 3-5 0-8z" fill="#f6a623" />
      <rect x="30" y="34" width="4" height="10" rx="1" fill="#d7262f" />
    </svg>
  );
}

export function MysteryIcon(p: P) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden {...p}>
      <path d="M8 22 32 12l24 10v26L32 58 8 48z" fill="#13295a" stroke="#f6c343" strokeWidth="2" />
      <path d="M8 22 32 32l24-10M32 32v26" fill="none" stroke="#f6c343" strokeWidth="2" />
      <text x="44" y="47" textAnchor="middle" fontFamily="Oswald, sans-serif" fontWeight="700" fontSize="18" fill="#f6c343">?</text>
    </svg>
  );
}

export function TorchEmblem(p: P) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden {...p}>
      <circle cx="32" cy="32" r="29" fill="#fff6e3" stroke="#f6c343" strokeWidth="4" />
      <circle cx="32" cy="32" r="23" fill="none" stroke="#d7262f" strokeWidth="2" />
      <path d="M32 12c-7 7-8 13-3 17-1-4 1-7 3-9 2 3 4 6 2 10 6-4 5-11-2-18z" fill="#f6a623" />
      <path d="M32 20c-3 3-3 6-1 8 2-1 3-4 1-8z" fill="#ffe28a" />
      <path d="M24 30h16l-3 6H27z" fill="#c98a17" />
      <path d="M28 36h8l-2 16h-4z" fill="#d7262f" />
    </svg>
  );
}

export function LockIcon(p: P) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...p}>
      <path d="M7 11V8a5 5 0 0 1 10 0v3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor" />
    </svg>
  );
}

export function SoundIcon({ on, ...p }: P & { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
      {on ? <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" /> : <path d="m16 9 5 6m0-6-5 6" />}
    </svg>
  );
}

export function MotionIcon(p: P) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...p}>
      <path d="M5 5l14 14M19 5 5 19M12 3v4M12 17v4M3 12h4M17 12h4" />
    </svg>
  );
}

export function prizeArt(name: string, rarity: string) {
  const n = name.toLowerCase();
  if (/pass|ticket|vip/.test(n)) return TicketIcon;
  if (/hat|cap/.test(n)) return CapIcon;
  if (/shirt|tee/.test(n)) return ShirtIcon;
  if (/coin|chip|point|token/.test(n)) return CoinsIcon;
  if (/crate|box|chest/.test(n)) return rarity === "rare" || rarity === "common" ? SilverCrate : CrateIcon;
  if (/mystery/.test(n)) return MysteryIcon;
  return { common: CoinsIcon, rare: SilverCrate, epic: CrateIcon, legendary: TicketIcon }[rarity] ?? MysteryIcon;
}

function SilverCrate(p: P) {
  return <CrateIcon tone="silver" {...p} />;
}

// ---------- Backdrop pieces ----------

export function Palmetto({ flip, ...p }: P & { flip?: boolean }) {
  const angles = [-205, -178, -150, -122, -96, -68, -40, -12, 14];
  return (
    <svg viewBox="0 0 200 400" aria-hidden {...p} style={{ transform: flip ? "scaleX(-1)" : undefined, ...p.style }}>
      <path d="M96 400C104 310 88 210 104 112" stroke="currentColor" strokeWidth="11" fill="none" strokeLinecap="round" />
      {[380, 350, 320, 290, 260, 230, 200, 170, 140].map((y, i) => (
        <path key={y} d={`M${92 + i * 0.6} ${y}l14 -6`} stroke="currentColor" strokeOpacity=".55" strokeWidth="3" />
      ))}
      {angles.map((a) => {
        const r = ((a % 360) + 360) % 360;
        const left = r > 90 && r < 270;
        return (
          <path
            key={a}
            d="M0 0C28-16 70-14 104 16C92 12 80 10 70 12C74 16 76 20 76 24C62 14 40 8 0 0Z"
            fill="currentColor"
            transform={`translate(104 112) rotate(${a}) ${left ? "scale(1 -1)" : ""}`}
          />
        );
      })}
      <circle cx="104" cy="114" r="9" fill="currentColor" />
    </svg>
  );
}

export function Skyline(p: P) {
  const cables = [1080, 1110, 1140, 1170, 1200, 1260, 1290, 1320, 1350];
  const cables2 = [1300, 1330, 1360, 1390, 1450, 1480, 1510, 1540, 1570];
  return (
    <svg viewBox="0 0 1600 420" preserveAspectRatio="xMidYMax slice" aria-hidden {...p}>
      <defs>
        <linearGradient id="gm-water" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#23305f" />
          <stop offset=".4" stopColor="#101c44" />
          <stop offset="1" stopColor="#050b1c" />
        </linearGradient>
      </defs>
      {/* distant city */}
      <g fill="#0b1738">
        {[
          [300, 270, 40, 60], [345, 250, 30, 80], [380, 262, 50, 68], [436, 240, 26, 90], [470, 268, 60, 62],
          [540, 256, 34, 74], [580, 272, 70, 58], [900, 266, 44, 64], [950, 250, 30, 80], [985, 270, 56, 60],
        ].map(([x, y, w, h]) => <rect key={x} x={x} y={y} width={w} height={h} />)}
      </g>
      <g fill="#ffcf6a" opacity=".8">
        {Array.from({ length: 46 }, (_, i) => {
          const x = [300, 345, 380, 436, 470, 540, 580, 900, 950, 985][i % 10]! + 6 + ((i * 7) % 22);
          const y = 262 + ((i * 13) % 50);
          return <rect key={i} x={x} y={y} width="3" height="4" />;
        })}
      </g>
      {/* church steeple */}
      <g fill="#081230">
        <rect x="170" y="200" width="56" height="130" />
        <rect x="180" y="160" width="36" height="44" />
        <rect x="186" y="128" width="24" height="34" />
        <path d="M188 130 198 30l10 100z" />
        <rect x="120" y="240" width="60" height="90" />
        <rect x="226" y="250" width="70" height="80" />
      </g>
      <g fill="#ffcf6a">
        <rect x="192" y="176" width="4" height="10" />
        <rect x="200" y="176" width="4" height="10" />
        <rect x="194" y="140" width="8" height="12" opacity=".7" />
      </g>
      {/* cable-stayed bridge */}
      <g stroke="#0c1a44" strokeWidth="2.2">
        {cables.map((x) => <line key={x} x1="1230" y1="120" x2={x} y2="292" />)}
        {cables2.map((x) => <line key={x} x1="1420" y1="120" x2={x} y2="292" />)}
      </g>
      <g fill="#07102c">
        <path d="M1212 330 1226 104h8l14 226h-10l-8-150-8 150z" />
        <path d="M1402 330 1416 104h8l14 226h-10l-8-150-8 150z" />
        <rect x="1030" y="288" width="570" height="8" />
      </g>
      <g fill="#ffcf6a">
        {Array.from({ length: 19 }, (_, i) => <circle key={i} cx={1040 + i * 30} cy="286" r="2" />)}
        <circle cx="1230" cy="102" r="3" fill="#ff5a5a" />
        <circle cx="1420" cy="102" r="3" fill="#ff5a5a" />
      </g>
      {/* shoreline */}
      <path d="M0 322c120-8 240-4 380 0s300 6 460 0 340-6 760 0v20H0z" fill="#060d26" />
      <rect y="336" width="1600" height="84" fill="url(#gm-water)" />
      <g stroke="#ffcf6a" strokeLinecap="round" className="gm-shimmer">
        {Array.from({ length: 22 }, (_, i) => (
          <line key={i} x1={60 + i * 70} x2={90 + i * 70 + (i % 3) * 12} y1={352 + (i % 4) * 14} y2={352 + (i % 4) * 14} strokeWidth="2" opacity={0.25 + (i % 3) * 0.15} />
        ))}
      </g>
    </svg>
  );
}
