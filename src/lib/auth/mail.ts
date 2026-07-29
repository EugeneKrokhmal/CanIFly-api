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

export type MailLocale = "es" | "en";

export function appPublicUrl(): string {
  const raw =
    process.env.APP_URL ??
    process.env.PUBLIC_APP_URL ??
    process.env.CORS_ORIGIN ??
    "http://localhost:3000";
  return raw.replace(/\/$/, "");
}

export function mailFromAddress(): string {
  return process.env.MAIL_FROM ?? "CanIFly <onboarding@resend.dev>";
}

export function normalizeMailLocale(value: unknown): MailLocale {
  return value === "en" ? "en" : "es";
}

export function verificationUrl(locale: MailLocale, token: string): string {
  const path = locale === "en" ? "/en/verify-email" : "/verify-email";
  return `${appPublicUrl()}${path}?token=${encodeURIComponent(token)}`;
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

const COPY = {
  es: {
    subject: "Verifica tu email en CanIFly",
    tagline: "Mapa de espacio aéreo UAS en España",
    title: "Verifica tu email",
    hello: (name: string) => `Hola ${name},`,
    body: "Confirma tu cuenta de CanIFly para reportar obstáculos y zonas de vuelo en el mapa.",
    cta: "Verificar email",
    orPaste: "O pega este enlace en el navegador:",
    expires:
      "Este enlace caduca en 24 horas. Si no te has registrado, puedes ignorar este email.",
    footer: "Ayuda de planificación, no una autorización oficial",
    text: (name: string, url: string) =>
      `Hola ${name},\n\nConfirma tu cuenta de CanIFly:\n${url}\n\nEste enlace caduca en 24 horas.\n\nSi no te has registrado, ignora este email.\n\n— CanIFly · https://canifly.org`,
  },
  en: {
    subject: "Verify your CanIFly email",
    tagline: "Spain UAS airspace map",
    title: "Verify your email",
    hello: (name: string) => `Hi ${name},`,
    body: "Confirm your CanIFly account to report obstacles and fly spots on the map.",
    cta: "Verify email",
    orPaste: "Or paste this link into your browser:",
    expires:
      "This link expires in 24 hours. If you did not sign up, you can ignore this email.",
    footer: "Planning aid, not official clearance",
    text: (name: string, url: string) =>
      `Hi ${name},\n\nConfirm your CanIFly account:\n${url}\n\nThis link expires in 24 hours.\n\nIf you did not sign up, ignore this email.\n\n— CanIFly · https://canifly.org`,
  },
} as const;

export function verificationEmailContent(opts: {
  name: string;
  verifyUrl: string;
  locale?: MailLocale | string | null;
}): { subject: string; html: string; text: string } {
  const locale = normalizeMailLocale(opts.locale);
  const t = COPY[locale];
  const subject = t.subject;
  const text = t.text(opts.name, opts.verifyUrl);

  const site = escapeHtml(appPublicUrl());
  const name = escapeHtml(opts.name);
  const url = escapeHtml(opts.verifyUrl);

  const html = `
<!DOCTYPE html>
<html lang="${locale}">
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
              <p style="margin:6px 0 0 0;font-size:13px;color:#717171;">${escapeHtml(t.tagline)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px 8px 28px;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#222222;">
              <h1 style="margin:0 0 12px 0;font-size:20px;line-height:1.3;font-weight:700;">${escapeHtml(t.title)}</h1>
              <p style="margin:0 0 12px 0;font-size:15px;line-height:1.55;color:#222222;">${escapeHtml(t.hello(opts.name))}</p>
              <p style="margin:0 0 24px 0;font-size:15px;line-height:1.55;color:#717171;">
                ${escapeHtml(t.body)}
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 24px 0;">
                <tr>
                  <td style="border-radius:999px;background:#222222;">
                    <a href="${url}" style="display:inline-block;padding:12px 22px;font-family:system-ui,-apple-system,sans-serif;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">
                      ${escapeHtml(t.cta)}
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px 0;font-size:12px;line-height:1.5;color:#717171;">
                ${escapeHtml(t.orPaste)}
              </p>
              <p style="margin:0 0 20px 0;font-size:12px;line-height:1.5;word-break:break-all;">
                <a href="${url}" style="color:#ff385c;">${url}</a>
              </p>
              <p style="margin:0;font-size:12px;line-height:1.5;color:#b0b0b0;">
                ${escapeHtml(t.expires)}
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 28px 28px;font-family:system-ui,-apple-system,sans-serif;border-top:1px solid #f0f0f0;">
              <p style="margin:0;font-size:12px;color:#b0b0b0;">
                <a href="${site}" style="color:#717171;text-decoration:none;font-weight:600;">canifly.org</a>
                · ${escapeHtml(t.footer)}
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
