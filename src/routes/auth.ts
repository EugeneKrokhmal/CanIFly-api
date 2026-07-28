import { Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  authCredentialsSchema,
  authRegisterSchema,
} from "@canifly/middleware";
import { hashPassword, verifyPassword } from "../lib/auth/password";
import {
  clearAuthCookie,
  getSessionUser,
  setAuthCookie,
} from "../lib/auth/session";
import { ensurePostgisSchema, getDb, isDatabaseAvailable } from "../lib/db/client";
import { users } from "../lib/db/schema";

export const authRoutes = new Hono();

function publicUser(row: {
  id: string;
  email: string;
  name: string;
  operatorNumber: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
}) {
  return {
    id: row.id,
    email: row.email,
    name: row.name || row.email.split("@")[0] || "Pilot",
    operatorNumber: row.operatorNumber,
    bio: row.bio ?? null,
    avatarUrl: row.avatarUrl ?? null,
  };
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
    const passwordHash = await hashPassword(parsed.data.password);
    const { db } = getDb();

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (existing.length > 0) {
      return c.json({ error: "Email already registered" }, 409);
    }

    const [row] = await db
      .insert(users)
      .values({ email, passwordHash, name, operatorNumber })
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        operatorNumber: users.operatorNumber,
        bio: users.bio,
        avatarUrl: users.avatarUrl,
      });

    const user = publicUser(row);
    await setAuthCookie(c, { id: user.id, email: user.email });
    return c.json({ user });
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

    const user = {
      id: row.id,
      email: row.email,
      name: row.name || row.email.split("@")[0] || "Pilot",
      operatorNumber: row.operatorNumber,
      bio: row.bio,
      avatarUrl: row.avatarUrl,
    };
    await setAuthCookie(c, { id: user.id, email: user.email });
    return c.json({ user });
  } catch (err) {
    console.error("[auth/login]", err);
    return c.json({ error: "Login failed" }, 500);
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
    })
    .from(users)
    .where(eq(users.id, session.id))
    .limit(1);

  if (!row) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return c.json({
    user: {
      id: row.id,
      email: row.email,
      name: row.name || row.email.split("@")[0] || "Pilot",
      operatorNumber: row.operatorNumber,
      bio: row.bio,
      avatarUrl: row.avatarUrl,
    },
  });
});

authRoutes.post("/logout", (c) => {
  clearAuthCookie(c);
  return c.json({ ok: true });
});
