import { Hono } from "hono";
import { contactFormSchema } from "@canifly/middleware";
import { mailFromAddress, sendEmail } from "../lib/auth/mail";

export const contactRoutes = new Hono();

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, { count: number; resetAt: number }>();

function clientKey(c: { req: { header: (name: string) => string | undefined } }): string {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

function rateLimited(key: string): boolean {
  const now = Date.now();
  const row = hits.get(key);
  if (!row || row.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  if (row.count >= MAX_PER_WINDOW) return true;
  row.count += 1;
  return false;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function contactInbox(): string {
  return (
    process.env.CONTACT_TO_EMAIL?.trim() ||
    process.env.MAIL_CONTACT_TO?.trim() ||
    "krokhmaleugen@gmail.com"
  );
}

contactRoutes.post("/", async (c) => {
  try {
    const key = clientKey(c);
    if (rateLimited(key)) {
      return c.json({ error: "Too many messages. Try again later." }, 429);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = contactFormSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid message", details: parsed.error.flatten() },
        400,
      );
    }

    // Honeypot filled → pretend success
    if (parsed.data.website?.trim()) {
      return c.json({ ok: true });
    }

    const { name, email, category, message, locale } = parsed.data;
    const to = contactInbox();
    const subject = `[CanIFly ${category}] ${name}`;
    const text = [
      `Category: ${category}`,
      `From: ${name} <${email}>`,
      `Locale: ${locale ?? "—"}`,
      `IP: ${key}`,
      "",
      message,
    ].join("\n");

    const html = `
<!DOCTYPE html>
<html>
<body style="font-family:system-ui,sans-serif;line-height:1.5;color:#222">
  <p><strong>Category:</strong> ${escapeHtml(category)}</p>
  <p><strong>From:</strong> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</p>
  <p><strong>Locale:</strong> ${escapeHtml(locale ?? "—")}</p>
  <hr style="border:none;border-top:1px solid #ddd;margin:16px 0" />
  <pre style="white-space:pre-wrap;font-family:inherit;margin:0">${escapeHtml(message)}</pre>
  <p style="margin-top:24px;font-size:12px;color:#888">Sent via CanIFly contact form · ${escapeHtml(mailFromAddress())}</p>
</body>
</html>`.trim();

    await sendEmail({
      to,
      replyTo: email,
      subject,
      text,
      html,
    });

    return c.json({ ok: true });
  } catch (err) {
    console.error("[contact]", err);
    return c.json({ error: "Could not send message" }, 502);
  }
});
