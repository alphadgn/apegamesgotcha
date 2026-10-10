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
    const { emailTeam } = await import("./team-email.server");
    await emailTeam(supabaseAdmin, {
      template: "contact-notification",
      data: { name: data.name, email, message: data.message },
      key: `contact:${saved.id as string}`,
      replyTo: email, // reply straight to the person who asked
      auditPrefix: "contact",
      details: { message_id: saved.id },
    });
    return { ok: true };
  });
