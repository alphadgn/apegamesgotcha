// Emails to the ApeGames team (contact form questions, IRL prize claims). Server-only.
// Recipients: app_config.contact.notify_to (a list of addresses) when set, otherwise CONTACT_EMAIL
// (fun@ApeGamesGotcha.com).
// A failed email never fails the player's action; the outcome is written to audit_log.

import { CONTACT_EMAIL } from "./contact-email";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any;

export async function teamRecipients(db: Db): Promise<string[]> {
  const { data: cfg } = await db
    .from("app_config")
    .select("value")
    .eq("key", "contact")
    .maybeSingle();
  const configured = ((cfg?.value as { notify_to?: unknown } | null)?.notify_to ?? []) as unknown;
  const list = (Array.isArray(configured) ? configured : [configured]).filter(
    (x): x is string => typeof x === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x),
  );
  if (list.length) return [...new Set(list.map((x) => x.toLowerCase()))];
  return [CONTACT_EMAIL.toLowerCase()];
}

/** Send one template to the whole team and log the result as `<auditPrefix>.emailed` / `.email_failed`. */
export async function emailTeam(
  db: Db,
  opts: {
    template: string;
    data: Record<string, unknown>;
    key: string;
    replyTo?: string;
    auditPrefix: string;
    details: Record<string, unknown>;
  },
) {
  const failures: { to: string; error: string }[] = [];
  let recipients: string[] = [];
  try {
    recipients = await teamRecipients(db);
    const { sendTemplateEmail } = await import("./email-templates/send-email");
    for (const to of recipients) {
      try {
        await sendTemplateEmail(opts.template, to, {
          templateData: opts.data,
          idempotencyKey: `${opts.key}:${to}`,
          ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
        });
      } catch (e) {
        failures.push({ to, error: (e as Error).message });
      }
    }
  } catch (e) {
    failures.push({ to: "*", error: (e as Error).message });
  }
  if (!recipients.length) failures.push({ to: "*", error: "No team email to send to" });
  if (failures.length) console.error(`[${opts.auditPrefix}] email to the team failed`, failures);
  await db.from("audit_log").insert({
    actor: null,
    action: failures.length ? `${opts.auditPrefix}.email_failed` : `${opts.auditPrefix}.emailed`,
    details: { ...opts.details, recipients, failures },
  });
}
