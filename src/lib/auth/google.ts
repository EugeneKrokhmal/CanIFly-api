import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { ensurePostgisSchema, getDb, isDatabaseAvailable } from "../db/client.js";
import { users } from "../db/schema.js";
import { normalizeMailLocale, appHomeUrl, welcomeEmailContent, sendEmail, type MailLocale } from "./mail.js";
import { setAuthCookie } from "./session.js";

const STATE_TTL_MS = 10 * 60 * 1000;
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

type GoogleProfile = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

type StatePayload = {
  n: string;
  locale: string;
  returnTo: string;
  exp: number;
};

export function googleOAuthConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID?.trim() &&
      process.env.GOOGLE_CLIENT_SECRET?.trim(),
  );
}

function appOrigin(): string {
  return (process.env.APP_URL?.trim() || "http://localhost:3000").replace(
    /\/$/,
    "",
  );
}

function redirectUri(): string {
  return `${appOrigin()}/api/auth/google/callback`;
}

function stateSecret(): string {
  return process.env.JWT_SECRET?.trim() || "canifly-dev-google-oauth";
}

function signPayload(payload: string): string {
  return createHmac("sha256", stateSecret()).update(payload).digest("hex");
}

function safeReturnTo(value: string | undefined): string {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function safeLocale(value: string | undefined): string {
  const locale = value?.trim().toLowerCase();
  if (
    locale === "en" ||
    locale === "es" ||
    locale === "de" ||
    locale === "fr" ||
    locale === "pl" ||
    locale === "cs"
  ) {
    return locale;
  }
  return "en";
}

function buildState(locale: string, returnTo: string): string {
  const payload: StatePayload = {
    n: randomBytes(16).toString("hex"),
    locale: safeLocale(locale),
    returnTo: safeReturnTo(returnTo),
    exp: Date.now() + STATE_TTL_MS,
  };
  const body = JSON.stringify(payload);
  const sig = signPayload(body);
  return Buffer.from(JSON.stringify({ body, sig })).toString("base64url");
}

function parseState(state: string | undefined): StatePayload | null {
  if (!state) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(state, "base64url").toString("utf8"),
    ) as { body?: string; sig?: string };
    if (!parsed.body || !parsed.sig) return null;
    const expected = signPayload(parsed.body);
    if (
      expected.length !== parsed.sig.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(parsed.sig))
    ) {
      return null;
    }
    const payload = JSON.parse(parsed.body) as StatePayload;
    if (!payload.exp || payload.exp < Date.now()) return null;
    return {
      ...payload,
      locale: safeLocale(payload.locale),
      returnTo: safeReturnTo(payload.returnTo),
    };
  } catch {
    return null;
  }
}

function redirectToApp(c: Context, path: string): Response {
  const target = `${appOrigin()}${path.startsWith("/") ? path : `/${path}`}`;
  return c.redirect(target, 302);
}

async function exchangeCode(code: string): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_NOT_CONFIGURED");
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });

  const data = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "TOKEN_EXCHANGE_FAILED");
  }

  return data.access_token;
}

async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile> {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as GoogleProfile & { error?: string };
  if (!res.ok || !data.sub) {
    throw new Error(data.error || "USERINFO_FAILED");
  }
  return data;
}

async function upsertGoogleUser(profile: GoogleProfile, locale: string) {
  if (!profile.email?.trim()) {
    throw new Error("EMAIL_MISSING");
  }
  if (!profile.email_verified) {
    throw new Error("EMAIL_NOT_VERIFIED");
  }

  const email = profile.email.trim().toLowerCase();
  const now = new Date();
  const { db } = getDb();

  const [byGoogle] = await db
    .select()
    .from(users)
    .where(eq(users.googleId, profile.sub))
    .limit(1);

  if (byGoogle) {
    const [updated] = await db
      .update(users)
      .set({
        emailVerifiedAt: byGoogle.emailVerifiedAt ?? now,
        name:
          byGoogle.name?.trim() ||
          profile.name?.trim() ||
          email.split("@")[0] ||
          "Pilot",
        avatarUrl: byGoogle.avatarUrl ?? profile.picture ?? null,
      })
      .where(eq(users.id, byGoogle.id))
      .returning();
    return { user: updated ?? byGoogle, isNewUser: false };
  }

  const [byEmail] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (byEmail) {
    if (byEmail.googleId && byEmail.googleId !== profile.sub) {
      throw new Error("EMAIL_LINKED_OTHER_GOOGLE");
    }
    const [updated] = await db
      .update(users)
      .set({
        googleId: profile.sub,
        emailVerifiedAt: byEmail.emailVerifiedAt ?? now,
        name:
          byEmail.name?.trim() ||
          profile.name?.trim() ||
          email.split("@")[0] ||
          "Pilot",
        avatarUrl: byEmail.avatarUrl ?? profile.picture ?? null,
      })
      .where(eq(users.id, byEmail.id))
      .returning();
    return { user: updated ?? byEmail, isNewUser: false };
  }

  const [created] = await db
    .insert(users)
    .values({
      email,
      googleId: profile.sub,
      passwordHash: null,
      name: profile.name?.trim() || email.split("@")[0] || "Pilot",
      avatarUrl: profile.picture ?? null,
      locale: normalizeMailLocale(locale),
      emailVerifiedAt: now,
      termsAcceptedAt: now,
    })
    .returning();

  return { user: created, isNewUser: true };
}

async function sendWelcomeEmail(user: {
  email: string;
  name: string;
  locale: string | null;
}): Promise<void> {
  const mailLocale = normalizeMailLocale(user.locale) as MailLocale;
  const homeUrl = appHomeUrl(mailLocale);
  const content = welcomeEmailContent({
    name: user.name?.trim() || user.email.split("@")[0] || "Pilot",
    homeUrl,
    locale: mailLocale,
  });
  await sendEmail({
    to: user.email,
    subject: content.subject,
    html: content.html,
    text: content.text,
  });
}

export function handleGoogleAuthStart(c: Context): Response {
  if (!googleOAuthConfigured()) {
    return c.json({ error: "Google sign-in is not configured" }, 503);
  }

  const locale = safeLocale(c.req.query("locale") ?? undefined);
  const returnTo = safeReturnTo(c.req.query("returnTo") ?? undefined);
  const state = buildState(locale, returnTo);
  const clientId = process.env.GOOGLE_CLIENT_ID!.trim();

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");

  return c.redirect(url.toString(), 302);
}

export async function handleGoogleAuthCallback(c: Context): Promise<Response> {
  const state = parseState(c.req.query("state"));
  const locale = state?.locale ?? "en";
  const returnTo = state?.returnTo ?? `/${locale}`;
  const failPath = `${returnTo}${returnTo.includes("?") ? "&" : "?"}auth_error=google`;

  if (!googleOAuthConfigured()) {
    return redirectToApp(c, failPath);
  }

  const oauthError = c.req.query("error");
  if (oauthError) {
    return redirectToApp(c, failPath);
  }

  const code = c.req.query("code");
  if (!code || !state) {
    return redirectToApp(c, failPath);
  }

  try {
    if (!(await isDatabaseAvailable())) {
      return redirectToApp(c, failPath);
    }

    await ensurePostgisSchema();

    const accessToken = await exchangeCode(code);
    const profile = await fetchGoogleProfile(accessToken);
    const { user: row, isNewUser } = await upsertGoogleUser(profile, locale);

    if (isNewUser) {
      void sendWelcomeEmail(row).catch((err) => {
        console.error("[auth/google/callback] welcome mail", err);
      });
    }

    await setAuthCookie(c, { id: row.id, email: row.email });

    const successPath = returnTo.includes("?")
      ? `${returnTo}&auth=google`
      : `${returnTo}?auth=google`;
    return redirectToApp(c, successPath);
  } catch (err) {
    console.error("[auth/google/callback]", err);
    return redirectToApp(c, failPath);
  }
}
