// The gotcha machine with its DEMO / LIVE buttons. Nothing is picked when the page loads: both buttons
// blink and Click To Spin is greyed out until the player presses one.
//   DEMO → demo spins (signed out: the free one every 30 minutes in this browser; signed in: granted demo
//          spins + the free one, drawn by the server for the demo board).
//   LIVE → real on-chain spins. Signed out, Click To Spin turns green and opens sign-in when tapped.
// Out of spins, Click To Spin keeps glowing in the picked colour and points the player at Refill.
import { useState } from "react";
import { GotchaMachine, type GotchaPrize, type PlayMode } from "./GotchaMachine";
import { DemoGotchaMachine, DEMO_PRIZES } from "./DemoGotchaMachine";
import { PlayerGotchaMachine } from "./PlayerGotchaMachine";
import { useRefillGuide } from "./useRefillGuide";
import { openSignIn } from "@/components/wallet/walletUi";

export function SpinArcade({
  userId,
  prizes,
  footnote,
}: {
  /** Signed-in player (undefined = signed out). */
  userId?: string | undefined;
  /** Prize list for signed-out visitors (signed-in players load their own). */
  prizes?: GotchaPrize[] | undefined;
  footnote?: string | undefined;
}) {
  // Kept here (above the signed-in / signed-out switch) so a visitor who picks LIVE and signs in stays on LIVE.
  const [mode, setMode] = useState<PlayMode | null>(null);

  if (userId)
    return (
      <PlayerGotchaMachine
        userId={userId}
        {...(footnote ? { footnote } : {})}
        playMode={mode}
        onPlayModeChange={setMode}
      />
    );
  if (mode === "live") return <SignedOutLive prizes={prizes} onPlayModeChange={setMode} />;
  return <DemoGotchaMachine prizes={prizes} playMode={mode} onPlayModeChange={setMode} />;
}

/** LIVE for a signed-out visitor: the real machine's look, and Click To Spin opens sign-in. */
function SignedOutLive({
  prizes,
  onPlayModeChange,
}: {
  prizes?: GotchaPrize[] | undefined;
  onPlayModeChange: (mode: PlayMode) => void;
}) {
  const refill = useRefillGuide();
  return (
    <div className="gm-demo">
      <div className="gm-demo-bar">
        <span>
          Live spins are drawn on-chain by Chainlink VRF. Sign in to spin for real prizes.
        </span>
        <span className="gm-bar-actions">
          <button
            ref={refill.ref}
            type="button"
            className={`gm-refill-btn${refill.attention ? " is-refill-attention" : ""}`}
            onClick={() => {
              refill.clear();
              openSignIn({ then: "refill" }); // sign in first, then the payment window opens
            }}
          >
            Refill spins
          </button>
        </span>
      </div>
      <GotchaMachine
        credits={0}
        prizes={prizes?.length ? prizes : DEMO_PRIZES}
        onDraw={() => Promise.reject(new Error("Sign in to spin for real"))}
        onCheck={async () => []}
        onNoSpins={() => openSignIn()}
        noSpinsHint="Sign in to spin"
        signedOut
        playMode="live"
        onPlayModeChange={onPlayModeChange}
        footnote="Sign in, then refill with APE to spin for real prizes."
      />
    </div>
  );
}
