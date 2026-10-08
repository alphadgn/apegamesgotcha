import { Body, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";
import type { TemplateEntry } from "./registry";

interface Props {
  name?: string;
  email?: string;
  message?: string;
}

function ContactNotification({ name = "A visitor", email = "", message = "" }: Props) {
  return (
    <Html>
      <Head />
      <Preview>New question from {name}</Preview>
      <Body style={{ backgroundColor: "#ffffff", fontFamily: "Arial, sans-serif" }}>
        <Container style={{ padding: "24px" }}>
          <Heading style={{ fontSize: "20px", color: "#0c1b3d" }}>New question from the guide</Heading>
          <Text><strong>Name:</strong> {name}</Text>
          <Text><strong>Email:</strong> {email}</Text>
          <Text style={{ whiteSpace: "pre-wrap" }}>{message}</Text>
        </Container>
      </Body>
    </Html>
  );
}

export const template = {
  component: ContactNotification,
  subject: (d) => `New ApeGames Gotcha question from ${d["name"] ?? "a visitor"}`,
  displayName: "Contact form — owner alert",
  previewData: { name: "Jane Ape", email: "jane@example.com", message: "When does the Charleston event start?" },
} satisfies TemplateEntry;
