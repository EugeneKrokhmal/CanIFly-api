import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  authCookieName,
  signAuthToken,
  verifyAuthToken,
} from "./jwt";

export type SessionUser = {
  id: string;
  email: string;
};

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  };
}

export async function setAuthCookie(
  c: Context,
  user: SessionUser,
): Promise<void> {
  const token = await signAuthToken({ sub: user.id, email: user.email });
  setCookie(c, authCookieName(), token, cookieOptions());
}

export function clearAuthCookie(c: Context): void {
  deleteCookie(c, authCookieName(), {
    path: "/",
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
  });
}

export function readTokenFromRequest(c: Context): string | null {
  return getCookie(c, authCookieName()) ?? null;
}

export async function getSessionUser(
  c: Context,
): Promise<SessionUser | null> {
  const token = readTokenFromRequest(c);
  if (!token) return null;
  const payload = await verifyAuthToken(token);
  if (!payload) return null;
  return { id: payload.sub, email: payload.email };
}

export async function requireUser(
  c: Context,
): Promise<SessionUser | Response> {
  const user = await getSessionUser(c);
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return user;
}

export function isSessionUser(
  value: SessionUser | Response,
): value is SessionUser {
  return !(value instanceof Response);
}
