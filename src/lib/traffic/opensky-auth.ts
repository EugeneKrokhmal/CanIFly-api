/**
 * OpenSky OAuth2 client-credentials token (required for authenticated API access).
 * https://openskynetwork.github.io/opensky-api/rest.html#authentication
 */

const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

/** Refresh a bit before expiry. */
const REFRESH_MARGIN_MS = 60_000;

type TokenState = {
  accessToken: string;
  expiresAt: number;
};

const g = globalThis as typeof globalThis & {
  __openskyToken?: TokenState | null;
  __openskyTokenPromise?: Promise<string | null> | null;
};

export function openskyCredentialsConfigured(): boolean {
  return Boolean(
    process.env.OPENSKY_CLIENT_ID?.trim() &&
      process.env.OPENSKY_CLIENT_SECRET?.trim(),
  );
}

async function fetchAccessToken(): Promise<string | null> {
  const clientId = process.env.OPENSKY_CLIENT_ID?.trim();
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(
      `[opensky] token exchange failed: ${res.status}`,
      text.slice(0, 200),
    );
    return null;
  }

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    console.error("[opensky] token response missing access_token");
    return null;
  }

  const expiresInSec = data.expires_in ?? 1800;
  g.__openskyToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + expiresInSec * 1000 - REFRESH_MARGIN_MS,
  };
  return data.access_token;
}

/** Returns a Bearer token, or null when credentials are missing / exchange failed. */
export async function getOpenskyAccessToken(): Promise<string | null> {
  if (!openskyCredentialsConfigured()) return null;

  const cached = g.__openskyToken;
  if (cached && Date.now() < cached.expiresAt) {
    return cached.accessToken;
  }

  if (!g.__openskyTokenPromise) {
    g.__openskyTokenPromise = fetchAccessToken().finally(() => {
      g.__openskyTokenPromise = null;
    });
  }
  return g.__openskyTokenPromise;
}

/** Drop cached token so the next call refreshes (e.g. after 401). */
export function invalidateOpenskyToken(): void {
  g.__openskyToken = null;
}
