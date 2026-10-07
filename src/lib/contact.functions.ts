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
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const email = data.email.toLowerCase();
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await supabaseAdmin
      .from("contact_messages")
      .select("id", { count: "exact", head: true })
      .eq("email", email)
      .gte("created_at", since);
    if ((count ?? 0) >= 3) throw new Error("You've sent a few messages already — please try again in an hour.");
    const { error } = await supabaseAdmin
      .from("contact_messages")
      .insert({ name: data.name, email, message: data.message });
    if (error) {
      console.error("contact insert failed", error);
      throw new Error("Couldn't send your message. Please try again.");
    }
    return { ok: true };
  });
