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
  const text = `Hi ${opts.name},

Confirm your CanIFly account:
${opts.verifyUrl}

This link expires in 24 hours.

If you did not sign up, ignore this email.

— CanIFly · https://canifly.org`;

  const site = escapeHtml(appPublicUrl());
  const name = escapeHtml(opts.name);
  const url = escapeHtml(opts.verifyUrl);

  // Table-based layout for broad email-client support; colors match the web app.
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f7f7f7;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7f7f7;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:#ffffff;border:1px solid #ebebeb;border-radius:16px;overflow:hidden;">
          <tr>
            <td style="padding:28px 28px 8px 28px;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
              <p style="margin:0;font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#222222;">
                CanI<span style="color:#ff385c;">Fly</span>
              </p>
              <p style="margin:6px 0 0 0;font-size:13px;color:#717171;">Spain UAS airspace map</p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px 8px 28px;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#222222;">
              <h1 style="margin:0 0 12px 0;font-size:20px;line-height:1.3;font-weight:700;">Verify your email</h1>
              <p style="margin:0 0 12px 0;font-size:15px;line-height:1.55;color:#222222;">Hi ${name},</p>
              <p style="margin:0 0 24px 0;font-size:15px;line-height:1.55;color:#717171;">
                Confirm your CanIFly account to report obstacles and fly spots on the map.
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 24px 0;">
                <tr>
                  <td style="border-radius:999px;background:#222222;">
                    <a href="${url}" style="display:inline-block;padding:12px 22px;font-family:system-ui,-apple-system,sans-serif;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">
                      Verify email
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px 0;font-size:12px;line-height:1.5;color:#717171;">
                Or paste this link into your browser:
              </p>
              <p style="margin:0 0 20px 0;font-size:12px;line-height:1.5;word-break:break-all;">
                <a href="${url}" style="color:#ff385c;">${url}</a>
              </p>
              <p style="margin:0;font-size:12px;line-height:1.5;color:#b0b0b0;">
                This link expires in 24 hours. If you did not sign up, you can ignore this email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 28px 28px;font-family:system-ui,-apple-system,sans-serif;border-top:1px solid #f0f0f0;">
              <p style="margin:0;font-size:12px;color:#b0b0b0;">
                <a href="${site}" style="color:#717171;text-decoration:none;font-weight:600;">canifly.org</a>
                · Planning aid, not official clearance
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
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
