/**
 * Transactional email via Resend (https://resend.com).
 * Without RESEND_API_KEY, logs the message (local/dev only).
 */

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export function appPublicUrl(): string {
  const raw =
    process.env.APP_URL ??
    process.env.PUBLIC_APP_URL ??
    process.env.CORS_ORIGIN ??
    "http://localhost:3000";
  return raw.replace(/\/$/, "");
}

export function mailFromAddress(): string {
  return (
    process.env.MAIL_FROM ??
    "CanIFly <onboarding@resend.dev>"
  );
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();

  if (!apiKey) {
    console.info(
      `[mail] RESEND_API_KEY not set — skipping send to ${input.to}\nSubject: ${input.subject}\n${input.text}`,
    );
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: mailFromAddress(),
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend failed (${res.status}): ${body.slice(0, 400)}`);
  }
}

export function verificationEmailContent(opts: {
  name: string;
  verifyUrl: string;
}): { subject: string; html: string; text: string } {
  const subject = "Verify your CanIFly email";
  const text = `Hi ${opts.name},\n\nConfirm your CanIFly account:\n${opts.verifyUrl}\n\nThis link expires in 24 hours.\n\nIf you did not sign up, ignore this email.`;
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;line-height:1.5;color:#222;max-width:480px">
      <p>Hi ${escapeHtml(opts.name)},</p>
      <p>Confirm your CanIFly account:</p>
      <p><a href="${escapeHtml(opts.verifyUrl)}" style="display:inline-block;background:#222;color:#fff;text-decoration:none;padding:10px 16px;border-radius:999px;font-weight:600">Verify email</a></p>
      <p style="font-size:13px;color:#717171">Or open this link:<br/><a href="${escapeHtml(opts.verifyUrl)}">${escapeHtml(opts.verifyUrl)}</a></p>
      <p style="font-size:13px;color:#717171">This link expires in 24 hours. If you did not sign up, ignore this email.</p>
    </div>
  `.trim();
  return { subject, html, text };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
