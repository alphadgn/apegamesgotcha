import { Body, Button, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";
import type { TemplateEntry } from "./registry";

interface Props {
  prize?: string;
  username?: string;
  tokenId?: string;
  link?: string;
  expires?: string;
}

/** Sent to a winner who chose to receive a stock certificate by email: a one-time link to pick the wallet. */
function StockCertificateClaim({ prize = "Stock certificate", username = "", tokenId = "", link = "#", expires = "" }: Props) {
  return (
    <Html>
      <Head />
      <Preview>Claim your stock certificate: {prize}</Preview>
      <Body style={{ backgroundColor: "#ffffff", fontFamily: "Arial, sans-serif" }}>
        <Container style={{ padding: "24px", maxWidth: "560px" }}>
          <Heading style={{ fontSize: "22px", color: "#0c1b3d" }}>You won a stock certificate!</Heading>
          <Text>
            {username ? `Hi ${username}, you` : "You"} won <strong>{prize}</strong>
            {tokenId ? ` (certificate #${tokenId})` : ""} in ApeGames Gotcha.
          </Text>
          <Text>
            A stock certificate is an NFT that holds stock tokens in its own vault: whoever owns the NFT controls the tokens inside
            it. Tap the button, choose the wallet that should receive it, and we send it there.
          </Text>
          <Button
            href={link}
            style={{ backgroundColor: "#f6c343", color: "#141414", padding: "14px 22px", borderRadius: "8px", fontWeight: "bold", textDecoration: "none" }}
          >
            Claim my stock certificate
          </Button>
          <Text style={{ color: "#555", fontSize: "13px" }}>
            This link is for you only: anyone with it can claim the certificate, so don't forward it. It works once
            {expires ? ` and until ${expires}` : ""}. You can also claim it from My Machine when signed in.
          </Text>
          <Text style={{ color: "#555", fontSize: "13px" }}>Didn't play ApeGames Gotcha? You can ignore this email.</Text>
        </Container>
      </Body>
    </Html>
  );
}

export const template = {
  component: StockCertificateClaim,
  subject: (d) => `Claim your stock certificate: ${d["prize"] ?? "your prize"}`,
  displayName: "Stock certificate — claim link to the winner",
  previewData: { prize: "Stonk Certificate (Gold)", username: "Ape-1A2B3C", tokenId: "42", link: "https://apegamesgotcha.com/claim-stock?c=example", expires: "Nov 12, 2026" },
} satisfies TemplateEntry;
