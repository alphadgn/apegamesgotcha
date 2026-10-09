import { useEffect, useRef, useState } from "react";
import { prizeArt, TorchEmblem } from "./icons";
import { VerifiedShareForm } from "./VerifiedShare";

/** A fulfilled spin as shared: real spin id plus participation and prize-bonus points (strings, exact). */
export type ShareSpin = { id?: string; prize_name: string; rarity: string; points: number; participation?: string; bonus?: string };

export const TAGLINE = "The Games Are Calling. Take Your Spin.";

const RARITY: Record<string, { label: string; color: string }> = {
  common: { label: "Common", color: "#cbd5e1" },
  rare: { label: "Rare", color: "#38bdf8" },
  epic: { label: "Epic", color: "#b36bff" },
  legendary: { label: "Legendary", color: "#ffc83d" },
};

function shareText(spins: ShareSpin[], demo: boolean) {
  const total = spins.reduce((s, x) => s + x.points, 0);
  const lines = spins.map((s, i) => `${i + 1}. ${s.prize_name} (${RARITY[s.rarity]?.label ?? s.rarity})${demo ? "" : ` +${s.points}`}`);
  return [
    `My last ${spins.length === 1 ? "" : `${spins.length} `}ApeGames Gotcha ${demo ? "demo " : ""}pull${spins.length === 1 ? "" : "s"} 🎰`,
    ...lines,
    demo ? "" : `Total: +${total} pts`,
    TAGLINE,
    "#GoApeGames2026 @goApeGames",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Draw a 1080×1350 card (Instagram portrait) of the spins, using the same prize art as the machine. */
async function renderCard(spins: ShareSpin[], demo: boolean, artHost: HTMLElement): Promise<Blob | null> {
  const W = 1080, H = 1350;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  if (!g) return null;
  try {
    await document.fonts?.ready;
  } catch {
    /* fonts optional */
  }
  const display = "Oswald, 'Chakra Petch', sans-serif";

  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#050d24");
  bg.addColorStop(0.55, "#13295a");
  bg.addColorStop(1, "#5b2d5c");
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  g.fillStyle = "#d7262f";
  g.fillRect(0, H - 110, W, 110);
  g.fillStyle = "#f6c343";
  g.fillRect(0, H - 116, W, 6);

  // ApeGames emblem
  const logo = artHost.querySelector("[data-logo] svg");
  if (logo) {
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(logo));
    await img.decode().catch(() => {});
    if (img.complete && img.naturalWidth) g.drawImage(img, 60, 40, 96, 96);
  }
  g.textAlign = "center";
  g.fillStyle = "#f6c343";
  g.font = `700 44px ${display}`;
  g.fillText("GO APEGAMES 2026", W / 2, 96);
  g.fillStyle = "#fff6e3";
  g.font = `700 64px ${display}`;
  const n = spins.length;
  const what = n === 1 ? (demo ? "MY LAST DEMO PULL" : "MY LAST PULL") : `MY LAST ${n} ${demo ? "DEMO " : ""}PULLS`;
  g.fillText(what, W / 2, 176);

  const arts = Array.from(artHost.querySelectorAll("[data-art] > svg"));
  const rowH = 168, top = 228;
  for (let i = 0; i < spins.length; i++) {
    const s = spins[i]!;
    const r = RARITY[s.rarity] ?? RARITY["common"]!;
    const y = top + i * rowH;
    g.fillStyle = "rgba(7, 15, 38, 0.82)";
    g.beginPath();
    g.roundRect(70, y, W - 140, rowH - 22, 28);
    g.fill();
    g.strokeStyle = r.color;
    g.lineWidth = 4;
    g.stroke();
    // slot number
    g.fillStyle = "#0c1b3d";
    g.beginPath();
    g.arc(140, y + (rowH - 22) / 2, 36, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#f6c343";
    g.stroke();
    g.fillStyle = "#fff6e3";
    g.font = `700 38px ${display}`;
    g.fillText(String(i + 1), 140, y + (rowH - 22) / 2 + 13);
    // prize art
    const svg = arts[i];
    if (svg) {
      const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
      const img = new Image();
      img.src = src;
      await img.decode().catch(() => {});
      if (img.complete && img.naturalWidth) g.drawImage(img, 200, y + 14, 118, 118);
    }
    g.textAlign = "left";
    g.fillStyle = r.color;
    g.font = `600 28px ${display}`;
    g.fillText(r.label.toUpperCase(), 345, y + 58);
    g.fillStyle = "#fff6e3";
    g.font = `700 44px ${display}`;
    g.fillText(s.prize_name.toUpperCase(), 345, y + 108);
    if (!demo) {
      g.textAlign = "right";
      g.fillStyle = "#f6c343";
      g.font = `700 42px ${display}`;
      g.fillText(`+${s.points}`, W - 110, y + 80);
      if (s.participation != null && s.bonus != null) {
        g.fillStyle = "#c9d4ff";
        g.font = `500 22px ${display}`;
        g.fillText(`${s.participation} spin + ${s.bonus} bonus`, W - 110, y + 116);
      }
    }
    g.textAlign = "center";
  }

  g.fillStyle = "#fff6e3";
  g.font = `700 46px ${display}`;
  const total = spins.reduce((s, x) => s + x.points, 0);
  g.fillText(TAGLINE.toUpperCase(), W / 2, H - 42);
  g.font = `500 26px ${display}`;
  g.fillStyle = "#c9d4ff";
  g.fillText(demo ? "Demo spins · no prizes" : `TOTAL +${total} PTS · Drawn on-chain by Chainlink VRF`, W / 2, H - 140);

  return new Promise((res) => c.toBlob((b) => res(b), "image/png"));
}

/**
 * Share the player's previous five spins. Uses the device's share sheet (Instagram, TikTok, Facebook,
 * Messages… whatever the phone offers) with an image card; falls back to links on desktop.
 */
export function ShareSpinsButton({ spins, demo = false, className = "" }: { spins: ShareSpin[]; demo?: boolean; className?: string }) {
  const last5 = spins.slice(-5);
  const artHost = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ text: string; url: string; image: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const card = useRef<Blob | null>(null);
  const key = last5.map((s) => `${s.prize_name}|${s.rarity}|${s.points}`).join(",");

  useEffect(() => () => void (menu?.image && URL.revokeObjectURL(menu.image)), [menu]);

  // Pre-draw the image as soon as the button appears: iPhones only open the share sheet right after a tap.
  useEffect(() => {
    card.current = null;
    if (!key) return;
    let live = true;
    const t = window.setTimeout(() => {
      if (artHost.current) void renderCard(last5, demo, artHost.current).then((b) => live && (card.current = b));
    }, 50);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, demo]);

  if (!last5.length) return null;

  // Open our menu (social links) — the device share sheet is offered inside it as one more option.
  const share = async () => {
    setBusy(true);
    setCopied(false);
    const latest = last5[last5.length - 1];
    // Real spin id in the link: verified X shares must reference a fulfilled spin.
    const url = !demo && latest?.id ? `${window.location.origin}/spin/${latest.id}` : window.location.origin;
    const text = shareText(last5, demo);
    try {
      const blob = card.current ?? (artHost.current ? await renderCard(last5, demo, artHost.current) : null);
      card.current = blob;
      setMenu({ text, url, image: blob ? URL.createObjectURL(blob) : null });
    } finally {
      setBusy(false);
    }
  };

  const nav = (typeof navigator !== "undefined" ? navigator : undefined) as (Navigator & { canShare?: (d: ShareData) => boolean }) | undefined;
  const deviceShare = async () => {
    if (!menu || !nav?.share) return;
    const blob = card.current;
    const file = blob ? new File([blob], "apegames-gotcha-pulls.png", { type: "image/png" }) : null;
    try {
      if (file && nav.canShare?.({ files: [file] })) await nav.share({ files: [file], title: "ApeGames Gotcha", text: `${menu.text}\n${menu.url}` });
      else await nav.share({ title: "ApeGames Gotcha", text: menu.text, url: menu.url });
    } catch {
      /* cancelled */
    }
  };

  const enc = encodeURIComponent;
  return (
    <>
      <button type="button" className={`gm-share-btn ${className}`} onClick={() => void share()} disabled={busy}>
        {busy ? "Preparing…" : "Share my pulls"}
      </button>
      {/* hidden prize art, drawn into the share image */}
      <div ref={artHost} aria-hidden style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}>
        <div data-logo>
          <TorchEmblem width={96} height={96} />
        </div>
        {last5.map((s, i) => {
          const Art = prizeArt(s.prize_name, s.rarity);
          return (
            <div data-art key={i}>
              <Art width={128} height={128} />
            </div>
          );
        })}
      </div>
      {menu && (
        <div className="gm-rf-overlay" onMouseDown={(e) => e.target === e.currentTarget && setMenu(null)}>
          <div className="gm-rf-panel" role="dialog" aria-modal="true" aria-label="Share your pulls">
            <div className="gm-rf-head">
              <h2>Share your pulls</h2>
              <button type="button" className="gm-rf-close" aria-label="Close" onClick={() => setMenu(null)}>
                ×
              </button>
            </div>
            {menu.image && <img src={menu.image} alt="Your last five pulls" className="gm-share-preview" />}
            <div className="gm-share-grid">
              {nav?.share && (
                <button type="button" onClick={() => void deviceShare()}>
                  More on this device…
                </button>
              )}
              <a href={`https://twitter.com/intent/tweet?text=${enc(menu.text)}&url=${enc(menu.url)}`} target="_blank" rel="noreferrer">X</a>
              <a href={`https://www.facebook.com/sharer/sharer.php?u=${enc(menu.url)}&quote=${enc(menu.text)}`} target="_blank" rel="noreferrer">Facebook</a>
              <a href={`https://wa.me/?text=${enc(`${menu.text}\n${menu.url}`)}`} target="_blank" rel="noreferrer">WhatsApp</a>
              <a href={`https://t.me/share/url?url=${enc(menu.url)}&text=${enc(menu.text)}`} target="_blank" rel="noreferrer">Telegram</a>
              <a href={`https://www.reddit.com/submit?url=${enc(menu.url)}&title=${enc(menu.text.split("\n")[0] ?? "")}`} target="_blank" rel="noreferrer">Reddit</a>
              <a href={`https://www.linkedin.com/sharing/share-offsite/?url=${enc(menu.url)}`} target="_blank" rel="noreferrer">LinkedIn</a>
              <a href={`sms:?&body=${enc(`${menu.text}\n${menu.url}`)}`}>Text message</a>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(`${menu.text}\n${menu.url}`).then(() => setCopied(true));
                }}
              >
                {copied ? "Copied!" : "Copy text"}
              </button>
              {menu.image && (
                <a href={menu.image} download="apegames-gotcha-pulls.png">
                  Save image (Instagram / TikTok)
                </a>
              )}
            </div>
            {!demo && last5[last5.length - 1]?.id && <VerifiedShareForm spinId={last5[last5.length - 1]!.id!} />}
          </div>
        </div>
      )}
    </>
  );
}
