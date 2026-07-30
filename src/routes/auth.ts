import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { and, eq, gt, isNull, isNotNull } from "drizzle-orm";
import {
  authCredentialsSchema,
  authEmailSchema,
  authRegisterSchema,
  authResetPasswordSchema,
  authVerifyTokenSchema,
  updateLocaleSchema,
} from "@canifly/middleware";
import { hashPassword, verifyPassword } from "../lib/auth/password";
import {
  normalizeMailLocale,
  resetPasswordEmailContent,
  resetPasswordUrl,
  sendEmail,
  verificationEmailContent,
  verificationUrl,
  type MailLocale,
} from "../lib/auth/mail";
import {
  clearAuthCookie,
  getSessionUser,
  setAuthCookie,
} from "../lib/auth/session";
import { ensurePostgisSchema, getDb, isDatabaseAvailable } from "../lib/db/client";
import { users } from "../lib/db/schema";

export const authRoutes = new Hono();

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

function publicUser(row: {
  id: string;
  email: string;
  name: string;
  operatorNumber: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  locale?: string | null;
}) {
  return {
    id: row.id,
    email: row.email,
    name: row.name || row.email.split("@")[0] || "Pilot",
    operatorNumber: row.operatorNumber,
    bio: row.bio ?? null,
    avatarUrl: row.avatarUrl ?? null,
    locale: normalizeMailLocale(row.locale),
  };
}

function newVerifyToken(): string {
  return randomBytes(32).toString("hex");
}

function newResetToken(): string {
  return randomBytes(32).toString("hex");
}

async function issueVerificationEmail(opts: {
  email: string;
  name: string;
  token: string;
  locale: MailLocale;
}) {
  const verifyUrl = verificationUrl(opts.locale, opts.token);
  const content = verificationEmailContent({
    name: opts.name,
    verifyUrl,
    locale: opts.locale,
  });
  await sendEmail({
    to: opts.email,
    subject: content.subject,
    html: content.html,
    text: content.text,
  });
}

async function issuePasswordResetEmail(opts: {
  email: string;
  name: string;
  token: string;
  locale: MailLocale;
}) {
  const resetUrl = resetPasswordUrl(opts.locale, opts.token);
  const content = resetPasswordEmailContent({
    name: opts.name,
    resetUrl,
    locale: opts.locale,
  });
  await sendEmail({
    to: opts.email,
    subject: content.subject,
    html: content.html,
    text: content.text,
  });
}

authRoutes.post("/register", async (c) => {
  try {
    if (!(await isDatabaseAvailable())) {
      return c.json({ error: "Database unavailable" }, 503);
    }

    await ensurePostgisSchema();

    const body = await c.req.json().catch(() => null);
    const parsed = authRegisterSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid registration", details: parsed.error.flatten() },
        400,
      );
    }

    const email = parsed.data.email.toLowerCase();
    const name = parsed.data.name.trim();
    const operatorNumber = parsed.data.operatorNumber;
    const locale = normalizeMailLocale(parsed.data.locale);
    const passwordHash = await hashPassword(parsed.data.password);
    const token = newVerifyToken();
    const expires = new Date(Date.now() + VERIFY_TTL_MS);
    const { db } = getDb();

    const existing = await db
      .select({
        id: users.id,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (existing.length > 0) {
      if (existing[0].emailVerifiedAt) {
        return c.json({ error: "Email already registered" }, 409);
      }
      // Unverified account: refresh password/token and resend.
      await db
        .update(users)
        .set({
          passwordHash,
          name,
          operatorNumber,
          locale,
          emailVerifyToken: token,
          emailVerifyExpires: expires,
        })
        .where(eq(users.id, existing[0].id));

      try {
        await issueVerificationEmail({ email, name, token, locale });
      } catch (err) {
        console.error("[auth/register] mail", err);
        return c.json({ error: "Could not send verification email" }, 502);
      }

      return c.json({
        needsVerification: true,
        email,
      });
    }

    await db.insert(users).values({
      email,
      passwordHash,
      name,
      operatorNumber,
      locale,
      emailVerifiedAt: null,
      emailVerifyToken: token,
      emailVerifyExpires: expires,
    });

    try {
      await issueVerificationEmail({ email, name, token, locale });
    } catch (err) {
      console.error("[auth/register] mail", err);
      return c.json({ error: "Could not send verification email" }, 502);
    }

    return c.json({
      needsVerification: true,
      email,
    });
  } catch (err) {
    console.error("[auth/register]", err);
    return c.json({ error: "Registration failed" }, 500);
  }
});

authRoutes.post("/login", async (c) => {
  try {
    if (!(await isDatabaseAvailable())) {
      return c.json({ error: "Database unavailable" }, 503);
    }

    await ensurePostgisSchema();

    const body = await c.req.json().catch(() => null);
    const parsed = authCredentialsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid credentials", details: parsed.error.flatten() },
        400,
      );
    }

    const email = parsed.data.email.toLowerCase();
    const { db } = getDb();

    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!row) {
      return c.json({ error: "Invalid email or password" }, 401);
    }

    const ok = await verifyPassword(parsed.data.password, row.passwordHash);
    if (!ok) {
      return c.json({ error: "Invalid email or password" }, 401);
    }

    if (!row.emailVerifiedAt) {
      return c.json(
        {
          error: "Email not verified",
          code: "EMAIL_NOT_VERIFIED",
          email: row.email,
        },
        403,
      );
    }

    const user = publicUser(row);
    await setAuthCookie(c, { id: user.id, email: user.email });
    return c.json({ user });
  } catch (err) {
    console.error("[auth/login]", err);
    return c.json({ error: "Login failed" }, 500);
  }
});

authRoutes.post("/verify-email", async (c) => {
  try {
    if (!(await isDatabaseAvailable())) {
      return c.json({ error: "Database unavailable" }, 503);
    }

    await ensurePostgisSchema();

    const body = await c.req.json().catch(() => null);
    const parsed = authVerifyTokenSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid verification token" }, 400);
    }

    const { db } = getDb();
    const now = new Date();
    const [row] = await db
      .select()
      .from(users)
      .where(
        and(
          eq(users.emailVerifyToken, parsed.data.token),
          gt(users.emailVerifyExpires, now),
        ),
      )
      .limit(1);

    if (!row) {
      return c.json({ error: "Invalid or expired verification link" }, 400);
    }

    const [updated] = await db
      .update(users)
      .set({
        emailVerifiedAt: now,
        emailVerifyToken: null,
        emailVerifyExpires: null,
      })
      .where(eq(users.id, row.id))
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        operatorNumber: users.operatorNumber,
        bio: users.bio,
        avatarUrl: users.avatarUrl,
        locale: users.locale,
      });

    const user = publicUser({ ...updated, locale: updated.locale ?? row.locale });
    await setAuthCookie(c, { id: user.id, email: user.email });
    return c.json({ user });
  } catch (err) {
    console.error("[auth/verify-email]", err);
    return c.json({ error: "Verification failed" }, 500);
  }
});

authRoutes.post("/resend-verification", async (c) => {
  try {
    if (!(await isDatabaseAvailable())) {
      return c.json({ error: "Database unavailable" }, 503);
    }

    await ensurePostgisSchema();

    const body = await c.req.json().catch(() => null);
    const parsed = authEmailSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid email" }, 400);
    }

    const email = parsed.data.email.toLowerCase();
    const { db } = getDb();
    const [row] = await db
      .select()
      .from(users)
      .where(and(eq(users.email, email), isNull(users.emailVerifiedAt)))
      .limit(1);

    // Always return ok to avoid email enumeration.
    if (!row) {
      return c.json({ ok: true });
    }

    const token = newVerifyToken();
    const expires = new Date(Date.now() + VERIFY_TTL_MS);
    await db
      .update(users)
      .set({
        emailVerifyToken: token,
        emailVerifyExpires: expires,
      })
      .where(eq(users.id, row.id));

    try {
      await issueVerificationEmail({
        email: row.email,
        name: row.name || row.email.split("@")[0] || "Pilot",
        token,
        locale: normalizeMailLocale(row.locale),
      });
    } catch (err) {
      console.error("[auth/resend-verification] mail", err);
      return c.json({ error: "Could not send verification email" }, 502);
    }

    return c.json({ ok: true });
  } catch (err) {
    console.error("[auth/resend-verification]", err);
    return c.json({ error: "Could not resend verification" }, 500);
  }
});

authRoutes.post("/forgot-password", async (c) => {
  try {
    if (!(await isDatabaseAvailable())) {
      return c.json({ error: "Database unavailable" }, 503);
    }

    await ensurePostgisSchema();

    const body = await c.req.json().catch(() => null);
    const parsed = authEmailSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid email" }, 400);
    }

    const email = parsed.data.email.toLowerCase();
    const { db } = getDb();
    const [row] = await db
      .select()
      .from(users)
      .where(and(eq(users.email, email), isNotNull(users.emailVerifiedAt)))
      .limit(1);

    if (!row) {
      return c.json({ ok: true });
    }

    const token = newResetToken();
    const expires = new Date(Date.now() + VERIFY_TTL_MS);
    await db
      .update(users)
      .set({
        passwordResetToken: token,
        passwordResetExpires: expires,
      })
      .where(eq(users.id, row.id));

    try {
      await issuePasswordResetEmail({
        email: row.email,
        name: row.name || row.email.split("@")[0] || "Pilot",
        token,
        locale: normalizeMailLocale(row.locale),
      });
    } catch (err) {
      console.error("[auth/forgot-password] mail", err);
    }

    return c.json({ ok: true });
  } catch (err) {
    console.error("[auth/forgot-password]", err);
    return c.json({ error: "Could not process request" }, 500);
  }
});

authRoutes.post("/reset-password", async (c) => {
  try {
    if (!(await isDatabaseAvailable())) {
      return c.json({ error: "Database unavailable" }, 503);
    }

    await ensurePostgisSchema();

    const body = await c.req.json().catch(() => null);
    const parsed = authResetPasswordSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid reset request" }, 400);
    }

    const { db } = getDb();
    const now = new Date();
    const [row] = await db
      .select()
      .from(users)
      .where(
        and(
          eq(users.passwordResetToken, parsed.data.token),
          gt(users.passwordResetExpires, now),
          isNotNull(users.emailVerifiedAt),
        ),
      )
      .limit(1);

    if (!row) {
      return c.json({ error: "Invalid or expired reset link" }, 400);
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const [updated] = await db
      .update(users)
      .set({
        passwordHash,
        passwordResetToken: null,
        passwordResetExpires: null,
      })
      .where(eq(users.id, row.id))
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        operatorNumber: users.operatorNumber,
        bio: users.bio,
        avatarUrl: users.avatarUrl,
        locale: users.locale,
      });

    const user = publicUser(updated);
    await setAuthCookie(c, { id: user.id, email: user.email });
    return c.json({ user });
  } catch (err) {
    console.error("[auth/reset-password]", err);
    return c.json({ error: "Password reset failed" }, 500);
  }
});

authRoutes.patch("/locale", async (c) => {
  try {
    const session = await getSessionUser(c);
    if (!session) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (!(await isDatabaseAvailable())) {
      return c.json({ error: "Database unavailable" }, 503);
    }

    await ensurePostgisSchema();

    const body = await c.req.json().catch(() => null);
    const parsed = updateLocaleSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid locale" }, 400);
    }

    const { db } = getDb();
    const [row] = await db
      .update(users)
      .set({ locale: parsed.data.locale })
      .where(eq(users.id, session.id))
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        operatorNumber: users.operatorNumber,
        bio: users.bio,
        avatarUrl: users.avatarUrl,
        locale: users.locale,
        emailVerifiedAt: users.emailVerifiedAt,
      });

    if (!row || !row.emailVerifiedAt) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    return c.json({ user: publicUser(row) });
  } catch (err) {
    console.error("[auth/locale]", err);
    return c.json({ error: "Failed to update locale" }, 500);
  }
});

authRoutes.get("/me", async (c) => {
  const session = await getSessionUser(c);
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (!(await isDatabaseAvailable())) {
    return c.json({
      user: {
        id: session.id,
        email: session.email,
        name: session.email.split("@")[0] || "Pilot",
        operatorNumber: null,
        bio: null,
        avatarUrl: null,
        locale: "es" as const,
      },
    });
  }

  const { db } = getDb();
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      operatorNumber: users.operatorNumber,
      bio: users.bio,
      avatarUrl: users.avatarUrl,
      locale: users.locale,
      emailVerifiedAt: users.emailVerifiedAt,
    })
    .from(users)
    .where(eq(users.id, session.id))
    .limit(1);

  if (!row || !row.emailVerifiedAt) {
    clearAuthCookie(c);
    return c.json({ error: "Unauthorized" }, 401);
  }

  return c.json({
    user: publicUser(row),
  });
});

authRoutes.post("/logout", (c) => {
  clearAuthCookie(c);
  return c.json({ ok: true });
});
