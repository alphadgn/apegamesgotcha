import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const contactSchema = z.object({
  name: z.string().trim().min(1, "Please add your name").max(100),
  email: z.string().trim().email("Please enter a valid email").max(255),
  message: z.string().trim().min(1, "Please write a message").max(2000),
  website: z.string().max(0).optional(), // honeypot
});

/** Public: anyone (signed in or not) can send a question to the ApeGames team. */
export const submitContact = createServerFn({ method: "POST" })
  .inputValidator((d) => contactSchema.parse(d))
  .handler(async ({ data }) => {
    if (data.website) return { ok: true }; // honeypot filled in: a bot, quietly ignored
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const email = data.email.toLowerCase();
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await supabaseAdmin
      .from("contact_messages")
      .select("id", { count: "exact", head: true })
      .eq("email", email)
      .gte("created_at", since);
    if ((count ?? 0) >= 3) throw new Error("You've sent a few messages already — please try again in an hour.");
    const { data: saved, error } = await supabaseAdmin
      .from("contact_messages")
      .insert({ name: data.name, email, message: data.message })
      .select("id")
      .single();
    if (error) {
      console.error("contact insert failed", error);
      throw new Error("Couldn't send your message. Please try again.");
    }
    // The message is saved; now email it to the team. A failed email never loses the message.
    await emailTeam(supabaseAdmin, { id: saved.id as string, name: data.name, email, message: data.message });
    return { ok: true };
  });

/**
 * Who gets contact emails: `app_config.contact.notify_to` (a list of addresses) when set,
 * otherwise every admin account's email.
 */
async function contactRecipients(db: any): Promise<string[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { data: cfg } = await db.from("app_config").select("value").eq("key", "contact").maybeSingle();
  const configured = ((cfg?.value as { notify_to?: unknown } | null)?.notify_to ?? []) as unknown;
  const list = (Array.isArray(configured) ? configured : [configured]).filter(
    (x): x is string => typeof x === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x),
  );
  if (list.length) return [...new Set(list.map((x) => x.toLowerCase()))];
  const { data: admins } = await db.from("user_roles").select("user_id").eq("role", "admin");
  const ids = new Set(((admins ?? []) as { user_id: string }[]).map((a) => a.user_id));
  const emails: string[] = [];
  for (const id of ids) {
    const { data } = await db.auth.admin.getUserById(id);
    if (data?.user?.email) emails.push(data.user.email.toLowerCase());
  }
  return [...new Set(emails)];
}

async function emailTeam(
  db: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  m: { id: string; name: string; email: string; message: string },
) {
  const failures: { to: string; error: string }[] = [];
  let recipients: string[] = [];
  try {
    recipients = await contactRecipients(db);
    const { sendTemplateEmail } = await import("./email-templates/send-email");
    for (const to of recipients) {
      try {
        await sendTemplateEmail("contact-notification", to, {
          templateData: { name: m.name, email: m.email, message: m.message },
          idempotencyKey: `contact:${m.id}:${to}`,
          replyTo: m.email, // reply straight to the person who asked
        });
      } catch (e) {
        failures.push({ to, error: (e as Error).message });
      }
    }
  } catch (e) {
    failures.push({ to: "*", error: (e as Error).message });
  }
  if (!recipients.length) failures.push({ to: "*", error: "No admin email to send to" });
  if (failures.length) console.error("[contact] email to the team failed", failures);
  await db.from("audit_log").insert({
    actor: null,
    action: failures.length ? "contact.email_failed" : "contact.emailed",
    details: { message_id: m.id, recipients, failures },
  });
}
