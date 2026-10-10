import { Body, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";
import type { TemplateEntry } from "./registry";

interface Props {
  prize?: string;
  player?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  delivery?: string;
  address?: string;
  notes?: string;
}

function PrizeClaimNotification({ prize = "IRL prize", player = "", fullName = "", email = "", phone = "", delivery = "", address = "", notes = "" }: Props) {
  return (
    <Html>
      <Head />
      <Preview>IRL prize claim: {prize}</Preview>
      <Body style={{ backgroundColor: "#ffffff", fontFamily: "Arial, sans-serif" }}>
        <Container style={{ padding: "24px" }}>
          <Heading style={{ fontSize: "20px", color: "#0c1b3d" }}>New IRL prize claim</Heading>
          <Text><strong>Prize:</strong> {prize}</Text>
          <Text><strong>Player account:</strong> {player}</Text>
          <Text><strong>Name:</strong> {fullName}</Text>
          <Text><strong>Email:</strong> {email}</Text>
          {phone ? <Text><strong>Phone:</strong> {phone}</Text> : null}
          <Text><strong>Delivery:</strong> {delivery}</Text>
          {address ? <Text style={{ whiteSpace: "pre-wrap" }}><strong>Ship to:</strong>{"\n"}{address}</Text> : null}
          {notes ? <Text style={{ whiteSpace: "pre-wrap" }}><strong>Notes:</strong> {notes}</Text> : null}
          <Text style={{ color: "#555" }}>Manage it in Admin → Leaderboard &amp; prizes → Prize winners.</Text>
        </Container>
      </Body>
    </Html>
  );
}

export const template = {
  component: PrizeClaimNotification,
  subject: (d) => `IRL prize claim: ${d["prize"] ?? "prize"} — ${d["fullName"] ?? "player"}`,
  displayName: "IRL prize claim — owner alert",
  previewData: { prize: "Charleston VIP Pass", player: "ape@example.com", fullName: "Jane Ape", email: "jane@example.com", phone: "+1 555 0100", delivery: "Pick up at ApeFest Charleston", notes: "Size L" },
} satisfies TemplateEntry;
